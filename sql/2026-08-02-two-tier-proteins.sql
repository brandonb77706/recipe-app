-- Two-tier protein avoidance.
--
-- `avoid_proteins` stays the full list of things the user doesn't want.
-- `strict_proteins` is the subset where a trace disqualifies the dish:
--   strict     -> ingredient scan, hard exclude (recipes.protein_traces)
--   preference -> main_protein only, as before
--
-- Both are nullable arrays with NO default, so the tri-state survives:
--   NULL = never answered, {} = answered "no preference", {...} = a real answer.

alter table preferences
  add column if not exists strict_proteins text[];

-- Which proteins appear anywhere in a recipe's ingredients, at any quantity.
-- Written by scripts/enrich-deterministic.ts; read only by strict exclusions.
alter table recipes
  add column if not exists protein_traces text[];

create index if not exists recipes_protein_traces_idx
  on recipes using gin (protein_traces);
