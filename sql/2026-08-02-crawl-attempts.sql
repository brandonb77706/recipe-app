-- Stops the crawler re-fetching pages it has already judged.
--
-- The pre-flight check only knew about URLs that made it into `recipes`. A page
-- that was fetched and then rejected — no JSON-LD, too few steps, stub content —
-- left no trace in the database, so every run fetched it again over the network
-- and rejected it again for the same reason. Roughly 2,300 pointless requests
-- per full run, at 1 req/sec, against other people's servers.
--
-- `outcome` holds the specific reason rather than a flat "failed", so a domain's
-- yield is one query instead of a grep:
--
--   select domain, outcome, count(*) from crawl_attempts
--   group by 1, 2 order by 1, 3 desc;

create table if not exists crawl_attempts (
  url          text primary key,
  domain       text not null,
  -- stored | duplicate | no_jsonld | rejected_<reason> | fetch_failed |
  -- insert_failed | threw
  outcome      text not null,
  detail       text,
  attempted_at timestamptz not null default now()
);

create index if not exists crawl_attempts_domain_idx  on crawl_attempts (domain);
create index if not exists crawl_attempts_outcome_idx on crawl_attempts (outcome);

-- Seed what we can prove: everything already in the corpus was fetched and
-- stored. The rejected pages are unrecoverable — they only ever existed in the
-- local logs — so the first run after this will re-fetch them one last time and
-- record them properly.
insert into crawl_attempts (url, domain, outcome, attempted_at)
select source_url, coalesce(source_domain, ''), 'stored', created_at
from recipes
where source_url is not null
on conflict (url) do nothing;
