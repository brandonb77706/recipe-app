-- Which environment served the card.
--
-- Dev and production share this database, so swipes from localhost and from
-- Vercel land in the same table and are indistinguishable. That mattered: a
-- Strict-Mode-only bug on localhost poisoned 43 rows, and feed-health.ts then
-- averaged them in with healthy production data and reported a problem that
-- had already been fixed. Reporting a false alarm is the same class of failure
-- as reporting healthy when it isn't — the check stops being believed either
-- way.
--
-- Nullable: the 249 rows that predate the logging columns stay null, and
-- feed-health filters on it rather than guessing.
alter table swipes add column if not exists client_env text;

alter table swipes drop constraint if exists swipes_client_env_check;
alter table swipes add constraint swipes_client_env_check
  check (client_env is null or client_env in ('development', 'production'));
