-- Phase 10 — cooking history and notes.
--
-- Two tables, not one, because they answer different questions:
--
--   cooks        an append-only event log. "I made this on Tuesday and it was
--                good." Each cook is its own row and nothing overwrites it —
--                the fourth time you make something, the first three still
--                happened. This is what makes "what do I actually cook"
--                answerable later.
--
--   recipe_notes one editable note per recipe. "Use half the sugar." Not an
--                event — a standing correction you rewrite as you learn the
--                dish. Storing this as the latest cook's note would lose it
--                the moment you logged a cook without repeating it.
--
-- Collapsing these into one table forces a choice between losing history and
-- re-entering your note every time.

create table if not exists cooks (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null,
  recipe_id   uuid not null references recipes(id) on delete cascade,
  cooked_at   timestamptz not null default now(),
  -- Three levels, not five stars. A 5-point scale invites agonising over 3 vs
  -- 4 and the extra resolution is noise at one user.
  rating      text check (rating in ('meh', 'good', 'great')),
  -- How it went THIS time. "Oven ran hot", "doubled it for guests".
  note        text,
  created_at  timestamptz not null default now()
);

create index if not exists cooks_user_recipe_idx on cooks (user_id, recipe_id);
create index if not exists cooks_cooked_at_idx   on cooks (user_id, cooked_at desc);

create table if not exists recipe_notes (
  user_id     uuid not null,
  recipe_id   uuid not null references recipes(id) on delete cascade,
  note        text not null,
  updated_at  timestamptz not null default now(),
  primary key (user_id, recipe_id)
);

-- Denormalised rollups on recipes, so the library grid can show "cooked 4x"
-- without a per-card subquery. Written by the API when a cook is logged;
-- never the source of truth — `cooks` is.
alter table recipes add column if not exists cook_count  integer not null default 0;
alter table recipes add column if not exists last_cooked_at timestamptz;

create index if not exists recipes_last_cooked_idx
  on recipes (user_id, last_cooked_at desc nulls last)
  where saved = true;
