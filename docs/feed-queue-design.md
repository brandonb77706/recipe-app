# Precomputed feed queue — design

**Goal:** Discover and the swipe deck open in ~100ms instead of ~505ms, by
serving a ranked queue that was built off the critical path.

**Core idea:** stop ranking at request time. Rank when something *changes*
(onboarding, a swipe, a preference edit), store the result, and serve reads
straight from it.

---

## The shape

```
READ PATH (what the user waits for)
  GET /api/discover
    1. SELECT from feed_queue WHERE user_id ORDER BY rank LIMIT 20   ~20ms
    2. hydrate those 20 ids                                          ~65ms
    3. respond                                                      ~100ms  ← 5x faster
    4. after(() => topUpIfLow())        ← runs AFTER the response is sent

WRITE PATH (nobody waits for this)
  regenerateFeed(userId)
    full sweep + score, exactly as today                            ~420ms
    replace feed_queue rows for that user with the top ~300
```

`after()` from `next/server` is what makes the second half possible on
serverless — there's no daemon, but there is post-response execution.

---

## Table

```sql
create table feed_queue (
  user_id         uuid not null,
  recipe_id       uuid not null,
  rank            int  not null,      -- position in the full ranking
  score           real not null,
  source          text not null check (source in ('ranked','explore')),
  candidate_count int  not null,      -- pool size at generation time
  generation      bigint not null,    -- bumped per rebuild
  created_at      timestamptz not null default now(),
  primary key (user_id, recipe_id)
);
create index feed_queue_serve_idx on feed_queue (user_id, rank);
```

`rank`, `source` and `candidate_count` are stored so the counterfactual logging
(`shown_rank`, `shown_source`) keeps working unchanged — `feed-health.ts` should
not notice this change happened.

---

## Regeneration triggers

| Trigger | Why | How |
|---|---|---|
| Onboarding completed | first feed, user is still reading the last screen | `after()` on `PUT /api/preferences` |
| Queue depth < 40 | keep it topped up mid-session | `after()` on `/api/discover` and `/api/swipe` |
| Preferences changed | **hard filters may now exclude queued cards** | delete queue synchronously, regenerate in `after()` |
| Right swipe (save) | taste profile moved | `after()` on `/api/swipe` |
| New crawl | new corpus rows exist | manual / script |

---

## The five risks, and what each needs

### 1. The queue must be a CACHE, never the source of truth  ⚠ most important
`after()` is best-effort. If the function is killed, or a deploy lands mid-flight,
regeneration silently doesn't happen.

**Requirement:** an empty or short queue falls back to the synchronous sweep that
exists today. The queue is then a pure optimization — if every part of it fails,
the app behaves exactly as it does now, just slower. This also makes it safe to
ship incrementally.

### 2. Stale hard filters can serve genuinely wrong cards
Hard filters are the "a wrong answer is unacceptable" set — `max_minutes`,
`diets`, `avoid_proteins`. If you lower your time limit to 20 minutes and the
queue still holds 45-minute recipes, the app breaks a promise it made.

**Requirement:** preference writes delete the queue **synchronously** before
responding, not in `after()`. Plus keep `passesHardFilters` as a guard at hydrate
time — a queued card that no longer passes gets dropped and the feed runs short
rather than wrong.

### 3. Taste drift
The queue is ranked by the profile at generation time. Confidence moves fastest
early — it went 0 → 0.44 over the first 11 saves.

**Requirement:** regenerate on every right swipe (saves are only ~12% of swipes,
so this is cheap), and top up on depth. Left swipes move the profile far less and
can ride until the depth trigger.

### 4. Exploration must be re-drawn, not frozen
A 300-deep queue holds ~60 exploration picks. If they sit there for a whole
session, "every 5th card is a surprise" becomes "the same 60 surprises".

**Requirement:** each regeneration re-draws exploration with a fresh RNG seed.
Bounded by how often regeneration happens, which the depth trigger already
controls.

### 5. Concurrent regeneration
Two requests can both decide the queue is short.

**Requirement:** skip if a generation completed within the last few seconds, and
make the write idempotent (delete + insert for that user in one transaction).
Duplicate work is wasteful but not incorrect.

---

## What this does NOT fix

- **First-ever load after onboarding** still pays the full sweep — but it happens
  while the user is finishing the questionnaire, so they don't wait on it.
- **Cold function start** is unchanged (~200ms of the cold number is Node boot).
- **Supabase egress** is unchanged per regeneration, but regenerations become far
  less frequent than deck loads, so total egress drops substantially.

---

## Suggested build order

1. **Table + `regenerateFeed()`**, called by nothing. Verify it produces the same
   ordering as the live path for the same inputs (a diff test, same as
   `verify-ranking`).
2. **Read path with fallback.** Serve from queue when populated, sweep when not.
   Ship here — everything still works if regeneration never runs.
3. **`after()` triggers**, one at a time: depth top-up, then right swipes, then
   preference invalidation.
4. **Re-measure**, and check `feed-health.ts` still reports a ~20% explore share
   and a top-of-pool median rank.

Step 2 is the safe stopping point if anything looks wrong.

---

## Expected outcome

| | today | with queue |
|---|---|---|
| Discover / deck open | ~505ms | **~100ms** |
| 60-card session, server work | ~1.7s | ~0.5s (mostly off-path) |
| Egress per session | ~9 MB | ~3 MB |
