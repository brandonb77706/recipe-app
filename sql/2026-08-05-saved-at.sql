-- "Recently added" was sorting by crawl date.
--
-- A library row saved by right-swiping a corpus recipe keeps the created_at it
-- got when the crawler stored it — which is when a stranger's blog post was
-- fetched, not when you decided to keep it. The two are unrelated, so the sort
-- was effectively arbitrary.
--
-- swipes.created_at already holds the real save moment, so the backfill is
-- exact for everything saved that way rather than a guess.

alter table recipes add column if not exists saved_at timestamptz;

-- Saved by swiping: the swipe is the save.
update recipes r
set saved_at = s.created_at
from swipes s
where s.recipe_id = r.id
  and s.direction = 'right'
  and r.saved = true
  and r.saved_at is null;

-- Hand-imported, or saved before swipes existed: created_at IS the save time
-- for these, because the row was created by the act of saving it.
update recipes
set saved_at = created_at
where saved = true and saved_at is null;

create index if not exists recipes_saved_at_idx
  on recipes (saved_at desc nulls last)
  where saved = true;
