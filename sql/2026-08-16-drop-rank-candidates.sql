-- Removes the SQL scorer. It was built, measured, and lost to the JS scorer:
-- the three percentile terms need three sorts of ~10,000 rows, which Postgres
-- did in 509ms against 44ms for the equivalent JS. Offset paging then repeated
-- that whole computation once per call.
--
-- Dropped rather than left in place because dead SQL that looks authoritative
-- is worse than no SQL — the next person reading this should find one scorer,
-- not two and a puzzle about which one runs. The scorer is src/lib/rank.ts.
--
-- rank_facets stays: counting facets in SQL genuinely beats doing it in JS.

drop function if exists rank_candidates(
  int, text[], text[], text[], uuid[], text[], text[], int,
  boolean, boolean, text[], boolean, text[], boolean,
  double precision, double precision, double precision, double precision,
  double precision, double precision, double precision, double precision,
  int, int
);
drop function if exists dish_score(text[]);
