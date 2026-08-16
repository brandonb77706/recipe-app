-- Pre-scoring in Postgres, so the API stops shipping the corpus to Node.
--
-- Before this: 17,474 rows in 18 sequential PostgREST pages, 2,629ms of a
-- 3,214ms request. A single 1,000-row page is 276ms — the cost was never the
-- data volume, it was the round trips.
--
-- This function applies the hard filters and the six mechanical scoring terms,
-- then returns only the top N. The two terms that do NOT live here are
-- deliberate: the learned taste profile and the tri-state preference handling
-- stay in TypeScript, where they're readable and already tested. A wrong
-- denominator in the taste average would produce plausible-but-incorrect
-- scores, which is the worst failure mode available.
--
-- Callers fetch 3,500 rows as four parallel calls (offset 0/1000/2000/3000)
-- because Supabase caps ANY result — table select or RPC — at 1,000 rows.
-- 3,500 is the provably-safe cutoff: the pre-taste score gap between rank 20
-- and rank 3,060 is 0.900, which equals the most the taste term can possibly
-- swing a card (WEIGHTS.TASTE). Nothing below that line can enter the top 20,
-- so the JS pass cannot be wrong about the head of the feed. Measured cost of
-- going deep: 3,000 rows is 203ms against 180ms for 500.

-- How much each meal type reads as "a thing to cook for a meal".
-- Mirrors DISH_SCORE in rank.ts; both must change together.
create or replace function dish_score(types text[])
returns double precision
language sql
immutable
as $$
  select coalesce(
    (select max(s) from unnest(coalesce(types, '{}')) t
      join (values ('dinner',1.0),('lunch',1.0),('breakfast',0.9),
                   ('snack',0.35),('dessert',0.35),('side',0.25),
                   ('sauce',0.0),('drink',0.0)) as d(k,s) on d.k = t),
    0.6  -- untagged: an enrichment gap, not evidence of a condiment
  )
$$;

create or replace function rank_candidates(
  -- hard filters
  p_max_minutes    int      default null,
  p_diets          text[]   default '{}',
  p_avoid_soft     text[]   default '{}',   -- match on main_protein only
  p_avoid_strict   text[]   default '{}',   -- match on protein_traces (any trace)
  p_swiped         uuid[]   default '{}',
  -- chip filters
  p_chip_meal      text[]   default '{}',
  p_chip_concepts  text[]   default '{}',
  p_chip_time      int      default null,
  -- scoring inputs
  p_want_protein   boolean  default false,
  p_want_low_cal   boolean  default false,
  p_concepts       text[]   default '{}',   -- tag-shaped concepts wanted
  p_concepts_cold  boolean  default false,
  p_cuisines       text[]   default '{}',
  p_cuisines_cold  boolean  default false,
  -- weights, passed in so WEIGHTS in rank.ts stays the single source of truth
  p_w_protein      double precision default 0.7,
  p_w_calorie      double precision default 0.5,
  p_w_concept      double precision default 0.6,
  p_w_cuisine      double precision default 0.3,
  p_w_dish         double precision default 0.7,
  p_w_effort       double precision default 0.15,
  p_cold_start     double precision default 0.4,
  p_calorie_floor  double precision default 250,
  p_limit          int default 1000,
  p_offset         int default 0
)
returns table (
  id uuid,
  pre_score double precision,
  raw_protein double precision,
  raw_calorie double precision,
  raw_concept double precision,
  raw_cuisine double precision,
  raw_dish double precision,
  raw_effort double precision,
  -- set-level facts the TypeScript notes cite, so ?debug=true keeps its prose
  n_protein int,
  n_calorie int,
  n_time int,
  pool_size int
)
language sql
stable
as $$
  with filtered as (
    select r.*
    from recipes r
    where r.saved = false
      and not (r.id = any(p_swiped))
      -- Unknown time fails a time cap: we can't promise 30 minutes on a recipe
      -- that never said, and a broken promise costs more than a missed card.
      and (p_max_minutes is null
           or (r.total_minutes is not null and r.total_minutes <= p_max_minutes))
      and (cardinality(p_diets) = 0 or r.diet_tags @> p_diets)
      and (cardinality(p_avoid_soft) = 0
           or r.main_protein is null
           or not (r.main_protein = any(p_avoid_soft)))
      and (cardinality(p_avoid_strict) = 0
           or not (coalesce(r.protein_traces, '{}') && p_avoid_strict))
      -- chips
      and (cardinality(p_chip_meal) = 0 or coalesce(r.meal_types,'{}') && p_chip_meal)
      and (cardinality(p_chip_concepts) = 0 or coalesce(r.concept_tags,'{}') @> p_chip_concepts)
      and (p_chip_time is null
           or (r.total_minutes is not null and r.total_minutes <= p_chip_time))
  ),
  counts as (
    select
      count(*) filter (where protein_grams is not null)::int as n_protein,
      count(*) filter (where calories is not null)::int      as n_calorie,
      count(*) filter (where total_minutes is not null)::int as n_time,
      count(*)::int                                          as pool_size,
      min(protein_grams) as p_min, max(protein_grams) as p_max,
      min(calories) as c_min,      max(calories) as c_max,
      min(total_minutes) as t_min, max(total_minutes) as t_max
    from filtered
  ),
  ranked as (
    select
      f.id, f.protein_grams, f.calories, f.total_minutes,
      f.cuisine, f.concept_tags, f.meal_types,
      -- Midrank percentile, matching percentile() in rank.ts exactly:
      --   (count(x < v) + count(x <= v)) / 2 / n
      -- cume_dist() gives count(x <= v)/n; (rank()-1)/n gives count(x < v)/n.
      -- Partitioning on the null test keeps NULL rows out of the distribution
      -- rather than sorting them to one end, which is what distributionOf does.
      case when f.protein_grams is null then null else
        ( cume_dist() over (partition by (f.protein_grams is null) order by f.protein_grams)
        + (rank() over (partition by (f.protein_grams is null) order by f.protein_grams) - 1)::double precision
          / greatest(1, count(*) over (partition by (f.protein_grams is null)))
        ) / 2 end as pct_protein,
      case when f.calories is null then null else
        ( cume_dist() over (partition by (f.calories is null) order by f.calories)
        + (rank() over (partition by (f.calories is null) order by f.calories) - 1)::double precision
          / greatest(1, count(*) over (partition by (f.calories is null)))
        ) / 2 end as pct_calorie,
      case when f.total_minutes is null then null else
        ( cume_dist() over (partition by (f.total_minutes is null) order by f.total_minutes)
        + (rank() over (partition by (f.total_minutes is null) order by f.total_minutes) - 1)::double precision
          / greatest(1, count(*) over (partition by (f.total_minutes is null)))
        ) / 2 end as pct_time
    from filtered f
  ),
  scored as (
    select
      r.id,
      -- protein: percentile when measured; the high_protein tag at the 0.5
      -- fallback when not; zero when there's no evidence either way.
      case
        when not p_want_protein then 0
        when r.protein_grams is not null then
          case when c.n_protein = 0 or c.p_min = c.p_max then 0.5 else r.pct_protein end
        when exists (select 1 from recipes rr where rr.id = r.id
                     and rr.diet_tags @> array['high_protein']) then 0.5
        else 0
      end as raw_protein,
      -- calorie: lower is better, then walked back below the meal floor so
      -- sauces and drinks can't win the term by being the lightest thing here.
      case
        when not p_want_low_cal then 0
        when r.calories is null then 0
        else (1 - (case when c.n_calorie = 0 or c.c_min = c.c_max then 0.5 else r.pct_calorie end))
             * least(1.0, r.calories / p_calorie_floor)
      end as raw_calorie,
      case
        when cardinality(p_concepts) > 0 then
          (select count(*) from unnest(p_concepts) x
            where coalesce(r.concept_tags,'{}') @> array[x])::double precision
          / cardinality(p_concepts)
        when p_concepts_cold then
          (select count(*) from unnest(array['meal_prep']) x
            where coalesce(r.concept_tags,'{}') @> array[x])::double precision
        else 0
      end as raw_concept,
      case
        when cardinality(p_cuisines) > 0 then
          case when r.cuisine = any(p_cuisines) then 1 else 0 end
        when p_cuisines_cold then
          case when r.cuisine = any(array['american','italian','mexican','mediterranean'])
               then 1 else 0 end
        else 0
      end as raw_cuisine,
      dish_score(r.meal_types) as raw_dish,
      case
        when r.total_minutes is null then 0.5
        when c.n_time = 0 or c.t_min = c.t_max then 0.5
        else 1 - r.pct_time
      end as raw_effort,
      c.n_protein, c.n_calorie, c.n_time, c.pool_size
    from ranked r cross join counts c
  )
  select
    s.id,
    s.raw_protein * p_w_protein
      + s.raw_calorie * p_w_calorie
      + s.raw_concept * (case when cardinality(p_concepts) > 0
                              then p_w_concept else p_w_concept * p_cold_start end)
      + s.raw_cuisine * (case when cardinality(p_cuisines) > 0
                              then p_w_cuisine else p_w_cuisine * p_cold_start end)
      + s.raw_dish * p_w_dish
      + s.raw_effort * p_w_effort                              as pre_score,
    s.raw_protein, s.raw_calorie, s.raw_concept,
    s.raw_cuisine, s.raw_dish, s.raw_effort,
    s.n_protein, s.n_calorie, s.n_time, s.pool_size
  from scored s
  -- id as the tiebreak, matching the JS sort, so paging is stable.
  order by pre_score desc, s.id asc
  limit p_limit offset p_offset
$$;

-- Facet counts over the pool BEFORE chips, so the numbers on the chips don't
-- move as you tap them. Separate function, issued in the same parallel wave.
create or replace function rank_facets(
  p_max_minutes int    default null,
  p_diets       text[] default '{}',
  p_avoid_soft  text[] default '{}',
  p_avoid_strict text[] default '{}',
  p_swiped      uuid[] default '{}'
)
returns table (kind text, key text, n int)
language sql
stable
as $$
  with filtered as (
    select r.*
    from recipes r
    where r.saved = false
      and not (r.id = any(p_swiped))
      and (p_max_minutes is null
           or (r.total_minutes is not null and r.total_minutes <= p_max_minutes))
      and (cardinality(p_diets) = 0 or r.diet_tags @> p_diets)
      and (cardinality(p_avoid_soft) = 0
           or r.main_protein is null
           or not (r.main_protein = any(p_avoid_soft)))
      and (cardinality(p_avoid_strict) = 0
           or not (coalesce(r.protein_traces, '{}') && p_avoid_strict))
  )
  select 'meal'::text, t, count(*)::int from filtered, unnest(coalesce(meal_types,'{}')) t group by t
  union all
  select 'concept'::text, t, count(*)::int from filtered, unnest(coalesce(concept_tags,'{}')) t group by t
  union all
  select 'protein'::text, coalesce(main_protein,'none'), count(*)::int from filtered group by 2
  union all
  select 'time'::text, b::text, count(*)::int
    from filtered, unnest(array[20,30,45]) b
    where total_minutes is not null and total_minutes <= b
    group by b
$$;

-- Counterfactual logging: what the ranker actually served, not just what was
-- swiped. Without shown_rank there is no way to tell a scoring regression from
-- a broken deck — the median-rank-1728 bug was only findable by reconstructing
-- this after the fact, and it would have been invisible a week later.
alter table swipes add column if not exists shown_rank      int;
alter table swipes add column if not exists shown_source    text;
alter table swipes add column if not exists candidate_count int;

alter table swipes drop constraint if exists swipes_shown_source_check;
alter table swipes add constraint swipes_shown_source_check
  check (shown_source is null or shown_source in ('ranked','explore'));
