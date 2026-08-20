# Discover / Swipe — optimization inventory

Every option, with measured or estimated impact. Baseline: **~505–573ms warm**
in production, ~3 MB Supabase egress per deck load.

**Session framing matters more than per-request timing.** `BATCH = 20`,
`REFILL_AT = 6`, so a refill fires roughly every 20 swipes. A 60-card session is
**3–4 full sweeps**, each costing ~420ms of avoidable server work (306ms sweep +
108ms scoring) and ~3 MB egress. Optimizing the *count* of sweeps beats
optimizing the cost of one.

---

## Correction: `offset` does not skip server work

`buildFeed(scored, limit, rng, offset)` slices the already-scored array
(`rank.ts:795`). Asking for `offset=40` still sweeps 9,900 rows and scores all
of them. Any plan built on "page deeper into the same ranking" saves **zero**
server time. This was wrong in the first version of the design doc.

---

## Tier 1 — high impact, low risk

### 1. Raise `BATCH` from 20 → 50  ⭐ best effort:impact ratio
**One line.** `MAX_LIMIT` is already 50, so no server change.
A 60-card session drops from ~4 sweeps to ~2.

- **Saves:** ~840ms and ~6 MB per 60-card session
- **Costs:** hydrate grows 20 → 50 rows (~65ms → ~120ms, one time)
- **Risk:** near zero. Exploration ratio unchanged (still every 5th card).
- **Watch:** more cards fetched than swiped if you quit early — wasted egress on
  abandoned sessions.

### 2. Drop the `COUNT(*)` round trip
`loadCandidates()` waits a full round trip just to compute the page count, then
fires 11 parallel pages.

- **Saves:** ~30ms every request
- **How:** fetch a fixed 18 pages speculatively and stop at the first short page,
  or cache the count keyed on the preference set
- **Risk:** low. Over-fetching empty pages costs a little; under-fetching would
  silently truncate the pool, so the stop condition must be "returned < PAGE".

### 3. Build component objects only for returned cards
Same shape as the notes fix. `scoreCandidates` allocates **7 objects per
candidate** — 69,300 to keep 140. Compute the numeric total for all, build the
`components` array only for the 20 that ship.

- **Saves:** est. 30–50% of the remaining 108ms scoring
- **Risk:** low, but `?debug=true` must still work — needs the same
  `{ notes: debug }` treatment applied to components.

---

## Tier 2 — bigger win, real design work

### 4. Prefetched ranked ids + hydrate-only endpoint  ⭐ the "eliminate wave 2" idea
First request returns 20 cards **plus the next ~100 ranked ids** (ids are cheap —
~40 bytes each, 4 KB total). Refills call a new `POST /api/recipes/hydrate`
with 20 ids: no sweep, no scoring, just one `IN (...)` query.

- **Saves:** ~420ms and ~3 MB on every refill after the first. A 60-card session
  goes from ~1.7s of server work to ~550ms.
- **Costs:** one new endpoint; the deck holds a ranked queue
- **Risk — the real one:** the ranking goes **stale**. The taste profile updates
  with every swipe, so a queue built at card 1 doesn't reflect what you taught it
  by card 40. Bound it: re-sweep every N cards (60 is reasonable) or whenever the
  queue empties. Exploration picks must still come from a fresh draw, or the
  same random tail cards sit in the queue for the whole session.
- **Also:** the client must drop queued ids it has since swiped — it already
  tracks that in `seen`.

### 5. Trim `RANK_COLUMNS` further
Currently 306 B/row × 9,900 = ~3 MB. `diet_tags` is only read for the
`high_protein` fallback (28% of rows); `source_domain` only by the taste term.

- **Saves:** ~19% egress, proportional wire time
- **Risk:** medium — this is exactly how `protein_source` became a landmine.
  Anything removed must be **deleted from the `RankRow` type**, not just the
  column list, so reads fail at compile time.

### 6. Skip `computeFacets` when no chips are active
Currently always runs over ~9,900 rows.

- **Saves:** ~5ms (measured). Marginal — listed for completeness.

---

## Tier 3 — plausible, unproven

### 7. Short-lived server cache of the scored ranking
Key on `(user_id, prefs_updated_at, swipe_count)`. Any swipe invalidates it,
which is most of the time — a swipe session invalidates on every card.

- **Verdict:** likely worthless *for the deck*, useful for the Discover grid
  where you browse without swiping.

### 8. Precomputed `base_score` column
Store the preference-independent part of the score, `ORDER BY` it in SQL, take
top N.

- **Blocker:** only `MAIN_DISH` is preference-independent. Protein, calorie,
  concept, cuisine and effort all depend on preferences, and the percentile terms
  are normalized **within the candidate set** — which changes per user and per
  filter. Precomputing them changes their meaning.
- **Verdict:** doesn't survive contact with the scoring model.

### 9. Partial index on `(saved, total_minutes)`
The hard filter runs on every sweep. Postgres may already be fast here — the
sweep cost looked like transfer, not query planning.

- **Next step:** `EXPLAIN ANALYZE` before building anything.

### 10. Nightly precomputed feed (cron)
Score everything offline, store the top 500 per user.

- **Verdict:** would make discover ~50ms, but it's a scheduled job, a new table,
  and a staleness story — for one user opening the app a few times a week.
  Disproportionate.

---

## Tier 4 — rejected, do not re-litigate

| Approach | Measured | Why |
|---|---|---|
| Score in SQL, return top N | 1,376–1,599ms | 3 percentile terms = 3 sorts of 10k rows; Postgres 509ms vs JS 44ms |
| Random-sample candidates | — | Loses the top of the feed |
| Module-scope corpus cache | 7× warm only | Instances don't share it; cold is the normal case |
| Vercel Pro for CPU | — | 3.7× penalty is ordinary serverless, not a tier wall |

---

## Recommended order

1. **`BATCH` 20 → 50** — one line, halves the sweeps
2. **Drop `COUNT(*)`** — ~30ms, small and safe
3. **Components only for returned cards** — same shape as the notes fix
4. Stop and re-measure. If a 60-card session is comfortable, stop here.
5. **Prefetched ids + hydrate endpoint** — only if the numbers still bother you,
   and only with a staleness bound

Steps 1–3 are roughly a day's work combined and carry almost no correctness risk.
Step 5 is the only one that changes how the deck thinks about the ranking, and it
is the only one that can serve stale cards.
