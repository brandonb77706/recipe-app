-- Full-text search + typo tolerance.
--
-- Run this whole file once. It backfills search_vector for all 8,462 rows as
-- part of adding the column, which takes a few seconds.

create extension if not exists pg_trgm;

-- array_to_string() is declared STABLE, not IMMUTABLE, because in general it
-- depends on the element type's output function — so any generation expression
-- mentioning it is rejected with "generation expression is not immutable".
--
-- For text[] specifically that caution doesn't apply: textout is immutable, so
-- this wrapper is safe to declare as such. It exists only to make that promise
-- to the planner.
create or replace function text_array_join(arr text[])
returns text
language sql
immutable
as $$
  select coalesce(array_to_string(arr, ' '), '')
$$;

-- Ingredient names out of the jsonb array, as one string.
-- Must be IMMUTABLE to be usable in a generated column. The jsonb_typeof guard
-- keeps a malformed row from erroring the whole table rewrite.
create or replace function recipe_ingredient_names(ing jsonb)
returns text
language sql
immutable
as $$
  select coalesce(string_agg(elem->>'name', ' '), '')
  from jsonb_array_elements(
    case when jsonb_typeof(ing) = 'array' then ing else '[]'::jsonb end
  ) as elem
$$;

-- Weighted document. A title match must beat an ingredient mention — searching
-- "chicken" should surface chicken dishes, not every recipe with chicken broth
-- in it, and ts_rank weights A=1.0 down to D=0.1 by default.
--
--   A  title, concept_tags       what the dish is
--   B  cuisine, meal_types, diet_tags
--   C  ingredient names          what's merely in it
--
-- Underscores become spaces so "meal prep" matches the meal_prep tag and
-- "middle eastern" matches middle_eastern, without relying on how the default
-- parser happens to tokenize an underscore.
alter table recipes
  add column if not exists search_vector tsvector
  generated always as (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english',
      replace(text_array_join(concept_tags), '_', ' ')), 'A') ||
    setweight(to_tsvector('english',
      replace(coalesce(cuisine, ''), '_', ' ')), 'B') ||
    setweight(to_tsvector('english',
      replace(text_array_join(meal_types), '_', ' ')), 'B') ||
    setweight(to_tsvector('english',
      replace(text_array_join(diet_tags), '_', ' ')), 'B') ||
    setweight(to_tsvector('english',
      coalesce(recipe_ingredient_names(ingredients), '')), 'C')
  ) stored;

create index if not exists recipes_search_vector_idx
  on recipes using gin (search_vector);

-- Trigram index on title only. Typo tolerance is for dish names — nobody
-- misspells their way into an ingredient list.
create index if not exists recipes_title_trgm_idx
  on recipes using gin (title gin_trgm_ops);

-- Returns ids and a relevance score. Full-text first; the trigram arm only
-- fires when full-text found fewer than 5 rows, so a real query is never
-- polluted by fuzzy matches and "quesadila" still finds quesadillas.
--
-- Only ids come back — the API route hydrates, applies preference filters and
-- breaks ties on the taste score, so ranking policy stays in TypeScript.
create or replace function search_recipes(
  q text,
  want_saved boolean,
  max_rows int default 300
)
returns table (id uuid, relevance real, match_kind text)
language sql
stable
as $$
  with fts as (
    select
      r.id,
      ts_rank(r.search_vector, websearch_to_tsquery('english', q)) as relevance,
      'fts'::text as match_kind
    from recipes r
    where r.saved = want_saved
      and r.search_vector @@ websearch_to_tsquery('english', q)
    order by relevance desc
    limit max_rows
  ),
  fuzzy as (
    select
      r.id,
      word_similarity(q, r.title) as relevance,
      'trigram'::text as match_kind
    from recipes r
    where r.saved = want_saved
      and q <% r.title
    order by relevance desc
    limit max_rows
  )
  select * from fts
  union all
  select * from fuzzy
  where (select count(*) from fts) < 5
    and fuzzy.id not in (select f.id from fts f)
$$;
