@AGENTS.md

# Recipe Vault

Personal recipe app. Single user (me), no auth, not going to the App Store.
Runs as a PWA on my iPhone home screen. The goal is discovering recipes I
haven't seen and actually cooking them.

## Stack

Next.js 16.2.12 (App Router), TypeScript, Tailwind v4, Supabase Postgres.
Runtime deps: `@supabase/supabase-js`, `@anthropic-ai/sdk`, `cheerio`,
`entities`, `server-only`. `tsx` runs the scripts.

**Not Next 15.** `params` is a Promise with no sync fallback — use
`await ctx.params` with the `RouteContext<'/api/path/[id]'>` helper. Check
the bundled docs in `node_modules/next/dist/docs/` rather than assuming;
this has bitten us once already.

Tailwind v4 uses `@theme inline` in `globals.css` — there is no
`tailwind.config.js` and adding one won't do what you expect. Colors are CSS
custom properties (`--paper`, `--ink`, `--accent`, …) with a dark-mode block.
One accent color carries every interactive element; nothing else is colorful.

## Commands

```bash
npm run dev                                    # localhost:3000
npm run build && npm run lint
npx tsc --noEmit                               # run this before claiming done

npx tsx scripts/<name>.ts --dry-run            # every script supports it
npx tsx scripts/rank-explain.ts --spread       # inspect ranking
caffeinate -i -w <pid>                         # keep the mac awake for long runs
```

Env vars. Scripts read `.env.local` by hand — they don't get Next's loader.

**Secret, server-only, never `NEXT_PUBLIC_`:** `SUPABASE_SERVICE_KEY` (bypasses
RLS entirely — exposing it is a total compromise), `ANTHROPIC_API_KEY`,
`IMPORT_SECRET`, `PEXELS_API_KEY`.

**Public by design, and correctly `NEXT_PUBLIC_`:** `NEXT_PUBLIC_SUPABASE_URL`
and `NEXT_PUBLIC_SUPABASE_ANON_KEY`. The anon key is *built* to ship in a
browser bundle — it carries no privileges beyond what RLS grants, and the
browser cannot sign in without it. Treating it as a secret would mean
server-rendering the login form, which buys nothing. The distinction that
matters is anon vs service, not public vs private.

`SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_URL` are both read (`??`), because
which one exists depends on when `.env.local` was written.

## Architecture

Observed tree, not a sketch. If a file isn't here, it doesn't exist yet.

```text
src/lib/
  extract.ts        all recipe extraction. ONE copy, no duplicates.
                    JSON-LD via cheerio → LLM fallback. Decodes entities.
  nutrition.ts      parseNutrition + per-serving math, sanity caps,
                    formatProtein/formatCalories
  enrich.ts         pure derivations: effort, low-calorie, diet candidates,
                    derived diet tags, protein traces (strict avoidance)
  rank.ts           discovery scoring. Pure functions over fetched rows —
                    no network, no Supabase, so it's testable standalone.
  preferences.ts    preference vocabulary + tri-state contract.
                    Safe to import from .tsx (no runtime deps).
  format.ts         display formatting only — never cleans data
  types.ts          Recipe shape + RECIPE_COLUMNS. Safe to import from .tsx.
  supabase.ts       service-role client, "server-only" guarded

src/app/api/
  import/           POST url → recipe. Requires IMPORT_SECRET.
  import-ui/        thin proxy so the browser never sees that secret
  recipes/          GET library list (saved = true)
  recipes/[id]/     GET one recipe regardless of saved, DELETE one
  preferences/      GET/PUT the single preferences row
  discover/         ranked corpus feed. ?limit= ?offset= ?debug=true ?seed=

src/app/
  page.tsx          Discover — the ranked corpus feed, and the home screen
  library/          saved recipes grid + the import form
  recipe/[id]/      detail, checkable ingredients, servings scaler, cook mode
  onboarding/       first-run preference wizard
  settings/         same questions, autosaving
  layout.tsx  manifest.ts  globals.css

src/components/
  recipe-card.tsx       one card, shared by Discover and the library
  recipe-image.tsx      3 paths: AI-generated badge / real photo / fallback card
  cook-mode.tsx         full-screen steps + wake lock
  preference-fields.tsx chip pickers shared by onboarding and settings

scripts/            run manually via npx tsx, never on a request path
  seed.ts                  the crawler. Rate limits + robots.txt.
  enrich-llm.ts            Haiku tagging, batched 20/call. Run FIRST.
  enrich-deterministic.ts  free derivations. Run SECOND — pescatarian and
                           protein traces need main_protein to exist.
  generate-staples.ts      AI-written basics, marked llm_generated
  backfill-images.ts       Pexels/Openverse photos for imageless rows
  rank-explain.ts          prints score breakdowns. --spread --profile= --seed=

sql/                migrations I run by hand in the Supabase console.
                    Nothing applies them automatically. Say so explicitly
                    when a change needs one — it blocks everything after it.
```

**All logic server-side in API routes. Pages fetch JSON and render.**
This is the load-bearing constraint — I may wrap this in React Native later
and reuse the entire backend untouched. No business logic in components,
no direct Supabase calls from client code.

`format.ts` formats. It does not clean, strip, or transform data.
Cleaning happens once, at ingest, in `extract.ts`.

Anything expensive derived from a recipe is computed once by a script and
stored on the row — never per request. `protein_traces` is the example:
scanning ingredients on every feed load would mean pulling the ingredients
of all 8,000 candidates, which is exactly what `RANK_COLUMNS` avoids.

## Data model

One `recipes` table holding two kinds of row:

- **corpus** — `saved = false`, crawled automatically, 8,442 rows
- **library** — `saved = true`, recipes I chose to keep, ~20 rows

**This split is the most fragile thing in the app.** Any query touching
`recipes` must filter on `saved`, or my library fills with strangers'
recipes and Discover shows me things I already have. Check this when adding
any new query.

Columns, as they actually are:

```text
id user_id source_url url_hash title image_url author total_minutes servings
ingredients jsonb [{quantity, unit, name, raw}]   steps jsonb string[]
tags[] extraction_method raw_payload created_at saved source_domain
cuisine meal_types[] diet_tags[] concept_tags[] effort
protein_grams calories main_protein protein_traces[]
protein_source protein_confidence enriched_at
```

There is **no** `search_vector` column and no full-text index. Library
search, when it exists, has nothing to build on yet.

`raw_payload.jsonld` holds the full source JSON-LD node, capped at ~50KB.
Anything discarded at ingest costs a full re-crawl to recover, so we keep it.

Two other tables:

- `preferences` — exactly one row, `user_id` fixed to `00000000-…-0001`.
  **No row at all is the "never onboarded" state**, not an error.
- `swipes` — `id, user_id, recipe_id, direction, created_at`.

Coverage, so you know what you can rely on: 63% have measured protein, 85%
have calories, 99% have a cuisine, 100% have an image. `protein_source` is
only ever `measured` or `unknown` today — nothing writes `estimated` yet, so
the estimated-discount path in `rank.ts` is real but currently inert.

## Invariants

**Ingredient rendering.** If `quantity` is null, render `raw` verbatim —
nothing else. Otherwise `quantity + unit + name`, with decimals as unicode
fractions (0.5 → ½, 1.75 → 1¾), no trailing zeros. `null null salt to
taste` is the failure mode this prevents.

**Missing data is omitted, never zeroed.** No "0g", no "—", no placeholder
labels. `Protein: 0g` reads as a factual claim. Omit the element.
Estimated values render with a tilde (`~28g`); measured render plain.

**Servings scaling is display-only.** Never write a scaled quantity back.

**Three-state nulls, not two.**

- `protein_source`: `measured` | `estimated` | `unknown`
- Preferences: `null` (never asked) vs `[]` (deliberately no preference).
  These are different and the ranking treats them differently — `null` gets
  a cold-start prior at reduced weight, `[]` contributes exactly zero.
  Enforced through the interaction, not just the type: the only way to reach
  `[]` is the No-preference chip, and deselecting your last real choice
  returns to `null`. Nothing highlighted always means unanswered.

**Hard filters vs. boosts.** Hard filters only where a wrong answer is
unacceptable: `max_minutes`, `diets`, `avoid_proteins`, `saved = false`,
no existing swipe. Everything else is a ranking boost. The feed must never
go empty. Measured for the "low-cal + high-protein + meal-prep" combo: as
hard filters it returns 97 recipes, or 47 with a 30-minute cap. As boosts,
the same intent surfaces those at the top of a feed of thousands.

**`low_calorie` means "lightest third of its kind", not a number.**
Per-meal-type p33 thresholds in `LOW_CALORIE_P33` — dinner 364, lunch 351,
sauce 69 — derived from the corpus, not chosen. It replaced a flat
`calories <= 500`, which was a step function with no judgment in it: it tagged
71% of everything and 97% of sauces, and carried exactly the information
already sitting in the calories column.

Two things about it that look like bugs and aren't:

- **Per-type shares aren't uniformly 33%.** Sides come out at 60%, snacks at
  48%. Multi-type dishes are judged as the largest meal they claim to be, so a
  dinner/side dish gets the 364 line rather than 175 — it is a light dinner.
  "33% of its kind" holds *within single-type dishes*, not across the board.
- **The tag deliberately doesn't feed ranking.** `rank.ts` scores calories
  continuously by percentile within the candidate set, which is better because
  it's relative to what you actually filtered to. The tag exists for search
  ("low calorie dessert" should return light desserts) and to give the
  preference chip something true to say. Don't wire it into scoring.

The thresholds drift as the corpus grows. A full run of `enrich-deterministic`
recomputes p33 from what it scanned and prints it beside the stored values,
flagging past 15%. Partial (`--limit`) runs suppress the comparison — they read
in crawl order, so their percentiles describe one blog, not the corpus.

**Avoidance has two tiers.** `avoid_proteins` is the list; `strict_proteins`
is the subset where a trace anywhere disqualifies the dish (scan
`protein_traces`). Everything else matches on `main_protein` only. Pork and
shellfish default to strict. The costs are asymmetric: wrongly dropping a
chicken dish over a splash of broth is a missing card, wrongly serving bacon
to someone avoiding pork is a broken app. Validated on 1,200 rows — 46% of
pork traces and 61% of fish traces (worcestershire, fish sauce) sit in
recipes whose `main_protein` is something else entirely.

## Discovery

Scoring lives entirely in `rank.ts` and is normalized **within the candidate
set that survived hard filters**, never against the whole corpus — filter to
20-minute vegetarian and 20g of protein is the top of that world.

Use **percentile rank, not min–max**. Protein runs p90=29g, p99=56g,
max=117g; that top 1% is source-data garbage and under min–max one bad row
squashed every honest recipe into the bottom third.

Prefer a measured number over a tag wherever one exists. `protein_grams`
beats the `high_protein` tag on 63% of rows; the tag is the fallback for the
rest, scored mid-range so a binary guess can never outrank a measurement.

Two traps already paid for, both the same shape — the corpus holds 321
sauces, 506 drinks, 1,126 sides, and any signal that isn't "is this dinner"
gets won by them:

- Minimizing calories ranks condiments first. 887 of the 972 rows under
  150 cal are sauces, drinks, snacks or desserts. Hence `CALORIE_MEAL_FLOOR`.
- With no preferences set, the feed opened with dill pickles, burger
  seasoning and ketchup — all fast, all correctly tagged `meal_prep`.
  Hence the `MAIN_DISH` term.

Weights live in one exported `WEIGHTS` constant, each with a comment saying
what raising it costs. Tune there, nowhere else.

Every 5th card is an exploration pick from outside the top set, drawn with a
seedable RNG — `?seed=` makes a feed reproducible, `Math.random` otherwise.

`npx tsx scripts/rank-explain.ts --spread` is the tuning view: it samples
across the whole ranked range instead of the feed, because the feed is all
winners and weight problems only show at the bottom. Every score component
carries a plain-language note, and `?debug=true` returns the full breakdown.
Both exist so a baffling card can be traced to the term that caused it.

## Gotchas that have cost real time

**`middleware.ts` is `proxy.ts` in Next 16, and the old name fails SILENTLY.**
The file convention was renamed; a file called `middleware.ts` is simply never
invoked — no error, no warning. Auth middleware in the wrong file gives you an
app that looks protected and is wide open. The export must be named `proxy`
(or be the default export), and it lives at `src/proxy.ts`.

**PostgREST caps every query at 1000 rows** regardless of `.limit()`.
Paginate with `.range()`. This silently truncated an enrichment run to
1,000 of 8,462 rows.

**`{ count: "exact", head: true }` returns no error for a table that doesn't
exist.** It comes back `{ count: null, error: null }`, so a existence check
written that way reports success on a missing table. Verify schema with a real
`.select().limit(1)`, which errors properly.

**`.in()` starts failing above ~200 values** — 300 gives "fetch failed", 500
gives "Bad Request". Chunk at 100, and never discard the error: a swallowed
one nearly caused ~7,000 redundant page fetches on a crawler resume.

**Claude 5 models reject assistant prefill** with a 400. Use
`output_config.format` structured outputs instead. Haiku 4.5 still accepts
prefill, which is why `/api/import` still uses it. Structured-output schemas
need `additionalProperties: false` everywhere, nullable via `anyOf` (not
`["type", "null"]`), and no min/max constraints.

**`npx tsx -e` can't do top-level await** ("cjs output format"). Write a real
file under `scripts/`, or wrap the body in `main()`.

**HTML entities survive `JSON.parse`.** `<script>` content is raw text, so
cheerio never decodes it — `&#32;` and `&nbsp;` reach the database unless
`decodeText` runs. Decode before splitting instruction blobs, not after: a
literal `&nbsp;` isn't matched by `\s` and one unsplit marker loses the
whole recipe.

## Crawling

`allowLlmFallback: false` in the seed script, always. Sitemaps contain
plenty of non-recipe pages; enabling the LLM path would fire thousands of
calls trying to extract recipes from about-pages. JSON-LD or skip.

Per-domain: 1 req/sec minimum, robots.txt honored, domains parallel up to
6 concurrent. **These are other people's servers** — rate limits and
robots.txt are requirements, not suggestions.

Quality gate at ingest, not after: reject <3 ingredients, <2 steps,
<200 chars of step text, listicle title patterns, missing image.

Every fetched URL is recorded in `crawl_attempts` with its specific outcome
(`stored`, `no_jsonld`, `rejected_too_few_steps`, `fetch_failed`, …), and the
pre-flight check skips anything already judged — not just anything already
stored. Without it a rejected page is re-fetched on every run forever.
`--retry-failed` ignores that skip list, for re-walking pages that failed under
an older parser; pair it with `--domain=` to limit the blast radius.

    select domain, outcome, count(*) from crawl_attempts
    group by 1, 2 order by 1, 3 desc;

Live sources: budgetbytes, minimalistbaker, cookieandkate, loveandlemons,
pinchofyum, halfbakedharvest.

**Dead sources — do not re-add:** anything Dotdash Meredith (Serious Eats,
Allrecipes, Simply Recipes, Food & Wine) 403s plain fetches, no header
tweaking gets past it. Smitten Kitchen hand-rolls markup, 0/40 nutrition.

The corpus skews American (60%) and thin on East Asian food — japanese 89,
korean 49, vietnamese 36. That's a source-list problem, not a tagging one,
and no amount of ranking fixes it.

## Deliberate non-choices

Building these is a regression, not an improvement:

- **No embedding/vector search.** Tag overlap ranks well at this corpus
  size. Revisit only if it visibly disappoints in real use.
- **No collaborative filtering.** One user.
- **No auth, no RLS, no multi-user.**
- **No 5-star ratings.** Three levels (meh/good/great) is honest.
- **No Instagram/TikTok import yet.** Highest-maintenance piece in the
  project. Revisit after a month of real use with the crawled corpus.
- **No meal planning calendar, no shopping lists.**

## Working style

I want to understand the why before the how. Explain tradeoffs, then
implement — don't just produce code.

One phase at a time. **Verify against real data before moving on** —
fixtures hide the bugs that matter, and every serious bug in this project so
far was found by looking at actual rows, not by reasoning about the code.
Report in one or two sentences what to check.

Ask rather than assume when the schema or existing code is ambiguous.
One question is cheaper than a wrong phase.

Prefer fewer, clearer files. This is a personal project, not a platform.

Phase briefs are pasted into the conversation, not stored in the repo —
there is no `docs/` directory. This file is the only standing context.

## Where things stand

> **DO NOT CREATE A SECOND ACCOUNT before step 2 of the auth migration.**
> `recipes.saved` and `recipes.cook_count` are columns on the *shared* recipe
> row with no user scope. A brand-new account sees the existing user's entire
> library on its first `/api/recipes` call — verified with a throwaway account
> on 2026-08-16, not theoretical. A second user saving anything also silently
> moves it out of the first user's library, and any recipe one person saves
> disappears from everyone else's Discover.
>
> Signups are disabled in the Supabase dashboard, and that is what enforces
> this. With exactly one account, nothing is wrong.

Phases 1–6 done: library, detail, cook mode, import, PWA. 7–8 done: 8,442
corpus rows crawled, tagged and enriched. 9a–9d done: preferences,
onboarding, settings, ranking, `/api/discover`, Discover as the home screen.

**Next: 9e** — the swipe deck, undo, prefetch, `POST /api/swipe`. Then
10–12: cooking history and notes, library organization, offline.

Not built: swipe UI, cooking history, any offline support.

Known and unfixed: nothing outstanding.
