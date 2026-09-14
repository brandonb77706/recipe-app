# Recipe Vault — measured results

Every number here came from an instrumented run, not an estimate. The
**environment column matters**: production numbers are defensible without
caveat; local/dev numbers are real but inflated by on-demand compilation and
laptop-to-database latency, so quote them as relative improvements rather than
absolute latencies.

---

## API latency

| Change | Before | After | Env |
|---|---|---|---|
| Sequential → parallel row fetching (18 round trips → 11 concurrent) | 2,629ms | ~500ms | local |
| Collapsed 5 serial DB round trips into 2 parallel waves | 1,020ms | 850ms | local |
| In-memory corpus replacing a 9,900-row per-request sweep | 306ms | 1.6ms | local |
| Local JWT verification (JWKS) replacing 2 auth-server round trips | 546ms | 3.7ms | local |
| Skipped building 70,945 unused explanation strings per request | 31ms | 19ms | local |
| **End-to-end `/api/discover`, cold** | **1,587ms** | — | **prod** |
| **End-to-end `/api/discover`, warm** | — | **~505ms** | **prod** |

Production stage breakdown, 10 consecutive calls:

```
prefsAndSwipes   30ms      candidatesAndTaste  306ms
scoring         108ms      hydrate              65ms      total ~505ms
```

**Rejected after measurement** (documented so they aren't retried): moving
scoring into Postgres measured **1,376–1,599ms** — three percentile terms
require three sorts of 10k rows, which Postgres did in 509ms against 44ms for
the equivalent JavaScript.

---

## Recommendation quality

The strongest results, because they're production user data.

| Metric | Before | After |
|---|---|---|
| Median rank of served cards (of ~3,500–5,000 candidates) | 1,728 | **31** |
| Exploration share of feed (design target 20%) | 59% | ~20% |
| Save rate, rank 1–20 vs rank 1,001+ | — | **12% vs 3%** |

The 1,728 median was statistically indistinguishable from random sampling
(exploration-only expectation: 1,745) — the ranking was being computed correctly
and then discarded client-side. Found by adding counterfactual logging
(`shown_rank`, `shown_source`, `candidate_count`) to every swipe, which made an
invisible failure measurable.

---

## Data pipeline

| Metric | Value |
|---|---|
| Recipes ingested | **17,459** across 12 sources |
| Enrichment coverage | 100% tagged, 72% with parsed nutrition |
| Crawl attempts logged | 19,614 |
| Redundant fetches eliminated per crawl | **~2,300** (~40 min of third-party load) |
| Corpus meat-protein share, after source analysis | 23% → **36%** |

Source selection was driven by a **14-domain, 25-page reconnaissance** measuring
yield, nutrition coverage and protein mix per site before committing to a full
crawl — it overturned the initial hypothesis about which sites to use.

---

## Bugs found by instrumentation

| Issue | Impact avoided |
|---|---|
| PostgREST 1,000-row cap silently truncating a batch job | Enrichment was processing 1,000 of 8,462 rows |
| Swallowed `.in()` error above ~200 values | ~7,000 redundant third-party requests on resume |
| Credit exhaustion with no fail-fast | 31,721 retries against a dead API |
| Cross-user read leak (pre-launch, found with a throwaway account) | Any new account saw another user's full library |
| Unauthenticated write API incl. an LLM-spending endpoint | Public endpoint able to bill the owner's API key |
| Image optimizer at 5,000 transforms/month | Hobby quota exhausted in ~200 screens of normal use |

---

## Scale of the work

12,575 lines of TypeScript · 9 hand-run SQL migrations · 11 API routes ·
7-term weighted ranking model · 431 logged swipes feeding a learned taste profile
