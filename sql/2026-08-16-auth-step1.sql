-- Step 1 of the multi-user migration: real accounts, same data.
--
-- Run AFTER creating your account in the Supabase dashboard
-- (Authentication > Users > Add user), and AFTER replacing the placeholder
-- below with that user's UUID.
--
-- Everything currently belongs to a hardcoded constant. This repoints it at
-- the real auth user so that signing in shows the data you already have,
-- rather than an empty app next to 51 orphaned rows.
--
-- The recipes table is deliberately untouched: `saved` and `user_id` there are
-- the category error step 2 fixes, and moving them now would be a half
-- migration of the thing CLAUDE.md calls the most fragile part of the app.

begin;

-- Replace both occurrences with your real auth.users id.
\set old_id '00000000-0000-0000-0000-000000000001'
\set new_id 'c8820b1d-26ab-4bb4-b099-306f892fc0f7'

update preferences   set user_id = :'new_id'::uuid where user_id = :'old_id'::uuid;
update swipes        set user_id = :'new_id'::uuid where user_id = :'old_id'::uuid;
update cooks         set user_id = :'new_id'::uuid where user_id = :'old_id'::uuid;
update recipe_notes  set user_id = :'new_id'::uuid where user_id = :'old_id'::uuid;

-- recipes.user_id marks rows you hand-imported or saved. Same repoint, so the
-- library keeps working until step 2 replaces it with saved_recipes.
update recipes       set user_id = :'new_id'::uuid where user_id = :'old_id'::uuid;

commit;

-- Verify: every count should be 0.
select 'preferences' as t, count(*) from preferences where user_id = '00000000-0000-0000-0000-000000000001'
union all select 'swipes',       count(*) from swipes       where user_id = '00000000-0000-0000-0000-000000000001'
union all select 'cooks',        count(*) from cooks        where user_id = '00000000-0000-0000-0000-000000000001'
union all select 'recipe_notes', count(*) from recipe_notes where user_id = '00000000-0000-0000-0000-000000000001'
union all select 'recipes',      count(*) from recipes      where user_id = '00000000-0000-0000-0000-000000000001';
