/**
 * Corpus seeder. Crawls recipe blog sitemaps and stores JSON-LD recipes as
 * unsaved corpus rows for the discovery feed.
 *
 *   npx tsx scripts/seed.ts --domain=budgetbytes --limit=20 --dry-run
 *   npx tsx scripts/seed.ts --domain=budgetbytes --limit=20
 *   npx tsx scripts/seed.ts
 *
 * This touches other people's servers. robots.txt and rate limits are
 * requirements, not suggestions:
 *   - robots.txt is fetched first and obeyed; a disallowed sitemap skips the
 *     whole domain
 *   - Crawl-delay is honoured when longer than our own floor
 *   - 3 workers max, and never less than 1s between requests to one domain
 *   - URLs already stored are skipped without being fetched at all
 *   - so are URLs already fetched and rejected, via the crawl_attempts table
 *
 * Resumable: a re-run skips everything already judged, and a duplicate is a
 * skip, never an abort.
 *
 *   npx tsx scripts/seed.ts --domain=budgetbytes --retry-failed
 *
 * --retry-failed ignores the crawl_attempts skip list, for re-walking pages
 * that failed under an older parser or a stricter quality gate.
 */
import { readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { createClient } from "@supabase/supabase-js";
import { extractRecipe, normalizeUrl, sourceDomain } from "../src/lib/extract";
import { parseNutrition } from "../src/lib/nutrition";
import { dietCandidates, deriveProteinTraces } from "../src/lib/enrich";

// ---------------------------------------------------------------------------
// Sources — edit this list, not the logic below.
// ---------------------------------------------------------------------------

const SOURCES = [
  "budgetbytes.com",
  // smittenkitchen.com removed: hand-rolled posts, zero JSON-LD Recipe markup
  // (0 of 40 sampled across 2006-2024). Only the LLM path could read it, and
  // that is off for crawling by design.
  "minimalistbaker.com",
  "cookieandkate.com",
  "loveandlemons.com",
  "pinchofyum.com",
  // halfbakedharvest.com: emits every instruction in one HowToStep, which the
  // blob splitter now handles. Yield ~65%, but nutrition only ~15% — well
  // below the recipe-card tier.
  "halfbakedharvest.com",
  // --- added 2026-08-03 to fix a corpus that was 44% protein-less. Chosen
  // from a 14-domain, 25-page-each dry-run recon; each of these returned
  // >=83% parseable nutrition and >=18/25 yield. Meat share in the sample,
  // by title: cafedelites 59% (incl. fish), theseasonedmom 50%,
  // dinneratthezoo 52%, thestayathomechef 50%, thecountrycook 34%.
  "cafedelites.com",
  "theseasonedmom.com",
  "thecountrycook.net",
  "thestayathomechef.com",
  "dinneratthezoo.com",
  // plainchicken.com: 64% meat, the strongest signal in the recon, but only
  // 29% parseable nutrition — an older blog that predates recipe-card
  // plugins. Accepted knowingly; the LLM estimation pass backfills protein.
  "plainchicken.com",
  // tasteofhome.com is NOT here on purpose. 27,268 sitemap URLs would make it
  // over half the corpus in one run. Crawl it deliberately, capped:
  //   --domain=tasteofhome.com --sitemap-match=recipe-sitemap --sample
  //   --limit=3000 --gap=2000
  // damndelicious.net removed: all sitemaps 403, none declared in robots.txt.
  // thekitchn.com removed: every sitemap 403s, including the two its own
  // robots.txt declares. A bot wall, not a markup problem — same class as the
  // Dotdash Meredith properties.
];

// Dotdash Meredith properties (allrecipes, seriouseats, simplyrecipes,
// foodandwine) 403 plain fetches and no header tweaking gets past it.
// Don't add them.

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const CONCURRENCY = 3;
const DEFAULT_REQUEST_GAP_MS = 1000; // per domain
const MAX_CHILD_SITEMAPS = 40;
const FETCH_TIMEOUT_MS = 20000;

/** Section 0 quality gate. A page can carry valid Recipe markup and still be
 *  useless — roundup posts ("25 Best Chicken Dinners") are the worst
 *  offenders. Filtering at ingest beats hand-deleting rows later. */
export const QUALITY_RULES: {
  reason: string;
  fails: (r: CandidateRecipe) => boolean;
}[] = [
  {
    reason: "too_few_ingredients",
    fails: (r) => r.ingredients.length < 3,
  },
  { reason: "too_few_steps", fails: (r) => r.steps.length < 2 },
  {
    reason: "stub_content",
    fails: (r) => r.steps.join(" ").length < 200,
  },
  {
    reason: "listicle_title",
    fails: (r) =>
      /^\d+\s+(best|easy|amazing|delicious|favorite)/i.test(r.title),
  },
  {
    reason: "roundup_title",
    fails: (r) => /\b(round.?up|recipes?\s+to\s+try|ideas)\b/i.test(r.title),
  },
  { reason: "no_image", fails: (r) => !r.image_url },
];

/** Sitemap URLs that are never a single recipe. */
const URL_REJECT_PATTERNS = [
  /\/category\//i,
  /\/tag\//i,
  /\/author\//i,
  /\/page\/\d+/i,
  /\/wp-content\//i,
  /\/feed\/?$/i,
  /\/videos?\//i,
  /\/product\//i,
  /\/shop\//i,
  /-review\/?$/i,
  /-reviews\/?$/i,
  /\/(about|contact|privacy|terms|shop|subscribe|cookbook)\/?$/i,
];

type CandidateRecipe = {
  title: string;
  image_url: string | null;
  ingredients: unknown[];
  steps: string[];
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const FAILURE_LOG = join(__dirname, "seed-failures.log");
const REJECTED_LOG = join(__dirname, "seed-rejected.log");

// ---------------------------------------------------------------------------
// Env — must load before importing anything that reads process.env at module
// scope (extract.ts constructs an Anthropic client eagerly).
// ---------------------------------------------------------------------------

for (const line of readFileSync(join(ROOT, ".env.local"), "utf8").split("\n")) {
  const i = line.indexOf("=");
  if (i > 0 && !line.trimStart().startsWith("#")) {
    const key = line.slice(0, i).trim();
    if (!process.env[key]) process.env[key] = line.slice(i + 1).trim();
  }
}

// The project URL lives under either name depending on when .env.local
// was written; it is public either way.
process.env.SUPABASE_URL ||= process.env.NEXT_PUBLIC_SUPABASE_URL!;

const db = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit?.split("=").slice(1).join("=");
};
const has = (name: string) => args.includes(`--${name}`);

const DRY_RUN = has("dry-run");
// Sitemaps are ordered by post id, so the first N URLs are the oldest posts —
// useless for judging whether the quality gate is tuned right. Sampling takes
// a spread across the whole archive instead.
const SAMPLE = has("sample");
// Escape hatch for the skip list. After a parser or quality-gate fix, the
// pages that previously failed are exactly the ones worth re-walking — a
// permanent skip list with no way out is its own trap. Pair with --domain= to
// re-walk one site rather than all six.
const RETRY_FAILED = has("retry-failed");
/**
 * Only walk child sitemaps whose URL matches. Large publishers split their
 * index into recipe/, post/ and listicle/ sitemaps, and without this the
 * child-sitemap budget gets spent on articles and roundups that the quality
 * gate will reject anyway — after we've already fetched them.
 */
const SITEMAP_MATCH = flag("sitemap-match");
/**
 * Per-domain request gap. The 1s floor is fine for a personal blog; a
 * publisher with real monitoring deserves more room, and we gain nothing by
 * going fast.
 */
const REQUEST_GAP_MS = flag("gap") ? Number(flag("gap")) : DEFAULT_REQUEST_GAP_MS;

if (!Number.isFinite(REQUEST_GAP_MS) || REQUEST_GAP_MS < DEFAULT_REQUEST_GAP_MS) {
  console.error(`--gap must be a number >= ${DEFAULT_REQUEST_GAP_MS}`);
  process.exit(1);
}
const ONLY_DOMAIN = flag("domain");
const LIMIT = flag("limit") ? Number(flag("limit")) : Infinity;

if (Number.isNaN(LIMIT)) {
  console.error("--limit must be a number");
  process.exit(1);
}

const DOMAIN_CONCURRENCY = flag("concurrency")
  ? Number(flag("concurrency"))
  : 6;

if (!Number.isFinite(DOMAIN_CONCURRENCY) || DOMAIN_CONCURRENCY < 1) {
  console.error("--concurrency must be a positive number");
  process.exit(1);
}

let targets: string[] = SOURCES;
if (ONLY_DOMAIN) {
  const wanted = ONLY_DOMAIN.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const known = SOURCES.filter((d) => d.includes(wanted));
  if (known.length) {
    targets = known;
  } else if (wanted.includes(".")) {
    // Trialling a candidate source before committing it to SOURCES.
    targets = [wanted];
    console.log(`(${wanted} is not in SOURCES — trialling it)`);
  } else {
    console.error(
      `No source matches --domain=${ONLY_DOMAIN}. Known: ${SOURCES.join(", ")}`
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Polite fetching
// ---------------------------------------------------------------------------

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/122.0 Safari/537.36";

const lastRequestAt = new Map<string, number>();
const crawlDelayMs = new Map<string, number>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Blocks until this domain is allowed another request. */
async function waitForSlot(domain: string) {
  const gap = Math.max(REQUEST_GAP_MS, crawlDelayMs.get(domain) ?? 0);
  for (;;) {
    const last = lastRequestAt.get(domain) ?? 0;
    const wait = last + gap - Date.now();
    if (wait <= 0) break;
    await sleep(wait);
  }
  lastRequestAt.set(domain, Date.now());
}

async function politeFetch(
  url: string,
  domain: string,
  onStatus?: (s: string) => void
): Promise<string | null> {
  await waitForSlot(domain);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": BROWSER_UA, Accept: "*/*" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      onStatus?.(`HTTP ${res.status}`);
      return null;
    }

    // .xml.gz sitemaps are served as a gzip body, which fetch does not
    // transparently decompress the way it does Content-Encoding.
    const buf = Buffer.from(await res.arrayBuffer());
    const isGzip = buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
    const text = isGzip ? gunzipSync(buf).toString("utf8") : buf.toString("utf8");
    onStatus?.(`ok, ${text.length} bytes${isGzip ? " (gunzipped)" : ""}`);
    return text;
  } catch (e) {
    onStatus?.(`error: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------

type Robots = {
  disallow: string[];
  allow: string[];
  sitemaps: string[];
  crawlDelaySec: number | null;
};

const EMPTY_ROBOTS: Robots = {
  disallow: [],
  allow: [],
  sitemaps: [],
  crawlDelaySec: null,
};

/** Minimal robots.txt parser. Reads the `*` group, which is the conservative
 *  choice — we never claim a friendlier user-agent to dodge a rule. */
export function parseRobots(text: string): Robots {
  const robots: Robots = {
    disallow: [],
    allow: [],
    sitemaps: [],
    crawlDelaySec: null,
  };
  let inStar = false;

  for (const raw of text.split("\n")) {
    const line = raw.split("#")[0].trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === "user-agent") {
      inStar = value === "*";
    } else if (field === "sitemap") {
      // Sitemap is a global directive, valid outside any user-agent group.
      robots.sitemaps.push(value);
    } else if (inStar && field === "disallow" && value) {
      robots.disallow.push(value);
    } else if (inStar && field === "allow" && value) {
      robots.allow.push(value);
    } else if (inStar && field === "crawl-delay") {
      const secs = Number(value);
      if (Number.isFinite(secs) && secs > 0) robots.crawlDelaySec = secs;
    }
  }
  return robots;
}

export function matchesRule(path: string, rule: string): boolean {
  // robots.txt wildcards: * matches any run, $ anchors the end.
  const escaped = rule
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  const anchored = escaped.endsWith("\\$")
    ? "^" + escaped.slice(0, -2) + "$"
    : "^" + escaped;
  try {
    return new RegExp(anchored).test(path);
  } catch {
    return false;
  }
}

export function isAllowed(url: string, robots: Robots): boolean {
  let path: string;
  try {
    const u = new URL(url);
    path = u.pathname + u.search;
  } catch {
    return false;
  }
  // Longest matching rule wins; Allow beats Disallow at equal length.
  let verdict = true;
  let best = -1;
  for (const rule of robots.disallow) {
    if (matchesRule(path, rule) && rule.length > best) {
      best = rule.length;
      verdict = false;
    }
  }
  for (const rule of robots.allow) {
    if (matchesRule(path, rule) && rule.length >= best) {
      best = rule.length;
      verdict = true;
    }
  }
  return verdict;
}

// ---------------------------------------------------------------------------
// Sitemaps
// ---------------------------------------------------------------------------

export function extractLocs(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
}

export const isSitemapIndex = (xml: string) => /<sitemapindex[\s>]/i.test(xml);

/** Child sitemaps that obviously hold taxonomy pages rather than posts. */
const skippableSitemap = (url: string) =>
  /(category|tag|author|user|taxonom)/i.test(url);

async function collectUrls(
  domain: string,
  robots: Robots,
  log: (s: string) => void
): Promise<{ urls: string[]; blocked: boolean }> {
  const candidates = [
    ...robots.sitemaps,
    `https://${domain}/wp-sitemap.xml`,
    `https://${domain}/sitemap_index.xml`,
    `https://${domain}/sitemap.xml`,
  ];

  for (const sitemapUrl of candidates) {
    if (!isAllowed(sitemapUrl, robots)) {
      log(`  robots.txt disallows ${sitemapUrl} — skipping domain`);
      return { urls: [], blocked: true };
    }

    const xml = await politeFetch(sitemapUrl, domain, (status) =>
      log(`  try ${sitemapUrl} -> ${status}`)
    );
    if (!xml) continue;
    if (!xml.includes("<loc")) {
      log(`       (no <loc> elements — not a sitemap)`);
      continue;
    }

    log(`  sitemap: ${sitemapUrl}`);
    let urls: string[] = [];

    if (isSitemapIndex(xml)) {
      const children = extractLocs(xml)
        .filter((u) => !skippableSitemap(u))
        .filter((u) => (SITEMAP_MATCH ? new RegExp(SITEMAP_MATCH, "i").test(u) : true))
        .slice(0, MAX_CHILD_SITEMAPS);
      log(`  ${children.length} child sitemap(s)`);
      for (const child of children) {
        if (!isAllowed(child, robots)) continue;
        const childXml = await politeFetch(child, domain);
        if (childXml) urls.push(...extractLocs(childXml));
        // Enough to satisfy the limit — stop pulling sitemaps. When
        // sampling we need the whole pool, so keep going.
        if (!SAMPLE && urls.length >= LIMIT * 5 && LIMIT !== Infinity) break;
      }
    } else {
      urls = extractLocs(xml);
    }

    if (urls.length) return { urls, blocked: false };
  }

  log("  no usable sitemap found");
  return { urls: [], blocked: false };
}

export function plausibleRecipeUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (URL_REJECT_PATTERNS.some((re) => re.test(u.pathname))) return false;

  const segments = u.pathname.split("/").filter(Boolean);
  if (!segments.length) return false; // homepage

  // Needs a real slug: hyphenated or reasonably wordy.
  const slug = segments[segments.length - 1];
  if (slug.length < 6) return false;
  if (!/[a-z]/i.test(slug)) return false;
  if (/\.(xml|jpg|jpeg|png|gif|pdf|webp)$/i.test(slug)) return false;

  return true;
}

/** Returns the reason a recipe fails the quality gate, or null to accept. */
export function qualityCheck(recipe: CandidateRecipe): string | null {
  return QUALITY_RULES.find((rule) => rule.fails(recipe))?.reason ?? null;
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

type DomainStats = {
  domain: string;
  found: number;
  considered: number;
  alreadyStored: number;
  alreadyAttempted: number;
  processed: number;
  inserted: number;
  skippedDuplicate: number;
  skippedNoJsonld: number;
  rejected: Record<string, number>;
  rejectedSamples: { reason: string; title: string; url: string }[];
  failed: number;
  withNutrition: number;
  blocked: boolean;
  /** Recon only. main_protein needs the LLM pass, so these are the
   *  deterministic proxies — same scan used on the existing corpus. */
  vegetarian: number;
  meatTrace: number;
  noAnimal: number;
  proteins: Record<string, number>;
  ingredientCounts: number[];
};

const newStats = (domain: string): DomainStats => ({
  domain,
  found: 0,
  considered: 0,
  alreadyStored: 0,
  alreadyAttempted: 0,
  processed: 0,
  inserted: 0,
  skippedDuplicate: 0,
  skippedNoJsonld: 0,
  rejected: {},
  rejectedSamples: [],
  failed: 0,
  withNutrition: 0,
  blocked: false,
  vegetarian: 0,
  meatTrace: 0,
  noAnimal: 0,
  proteins: {},
  ingredientCounts: [],
});

const rejectedTotal = (s: DomainStats) =>
  Object.values(s.rejected).reduce((a, b) => a + b, 0);

// ---------------------------------------------------------------------------
// Per-domain crawl
// ---------------------------------------------------------------------------

async function crawlDomain(
  domain: string,
  prefixed: boolean
): Promise<DomainStats> {
  const stats = newStats(domain);
  const tag = prefixed ? `[${domain.replace(/\.(com|net|org)$/, "")}] ` : "";
  const log = (s: string) => console.log(tag + s.trimStart().padStart(0));

  console.log(`\n=== ${domain} ===`);

  const robotsText = await politeFetch(`https://${domain}/robots.txt`, domain);
  const robots = robotsText ? parseRobots(robotsText) : EMPTY_ROBOTS;

  if (robots.crawlDelaySec) {
    crawlDelayMs.set(domain, robots.crawlDelaySec * 1000);
    log(`  robots.txt Crawl-delay: ${robots.crawlDelaySec}s (honoured)`);
  }
  if (!robotsText) log("  no robots.txt (treating as unrestricted)");
  else
    log(
      `  robots.txt: ${robots.disallow.length} disallow rules, ` +
        `${robots.sitemaps.length} sitemap(s) declared`
    );

  const { urls, blocked } = await collectUrls(domain, robots, log);
  if (blocked) {
    stats.blocked = true;
    return stats;
  }

  stats.found = urls.length;

  // Filter, normalize, dedupe within the run.
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const raw of urls) {
    if (!plausibleRecipeUrl(raw)) continue;
    if (!isAllowed(raw, robots)) continue;
    let norm: string;
    try {
      norm = normalizeUrl(raw);
    } catch {
      continue;
    }
    if (seen.has(norm)) continue;
    seen.add(norm);
    candidates.push(norm);
  }

  // Skip anything already stored *without fetching it* — this is what makes a
  // re-run cheap for us and invisible to their server.
  //
  // Chunk size matters: `.in()` becomes a query string, and PostgREST rejects
  // it past roughly 200 recipe URLs (300 fails to even build the request, 500
  // returns Bad Request). A silent failure here is the worst possible outcome —
  // the set comes back empty, every URL looks new, and a resumed run re-fetches
  // thousands of pages from someone else's blog. So: small chunks, and abort
  // loudly rather than continue with a half-built set.
  const stored = new Set<string>();
  const CHUNK = 100;
  for (let i = 0; i < candidates.length; i += CHUNK) {
    const chunk = candidates.slice(i, i + CHUNK);
    const { data, error } = await db
      .from("recipes")
      .select("source_url")
      .in("source_url", chunk);

    if (error) {
      log(
        `  ABORT: could not check which URLs are already stored (${error.message}). ` +
          `Refusing to continue — a resumed run would re-fetch every page.`
      );
      stats.blocked = true;
      return stats;
    }
    for (const row of data ?? []) stored.add(row.source_url);
  }

  // Second skip list: URLs we've already fetched and judged, whatever the
  // verdict. Without this, every rejected page — no JSON-LD, too few steps —
  // gets fetched again on every run to reach the same conclusion. Measured at
  // ~2,300 wasted requests per full crawl.
  //
  // Fetched per domain rather than chunked by URL: it's one indexed query per
  // domain instead of one per hundred candidates, and the row count is bounded
  // by how much of that sitemap we've walked.
  const attempted = new Set<string>();
  if (!RETRY_FAILED) {
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db
        .from("crawl_attempts")
        .select("url")
        .eq("domain", domain)
        .range(from, from + 999);

      if (error) {
        // Same reasoning as the stored check: a half-built skip list silently
        // becomes a full re-crawl of someone else's blog.
        log(
          `  ABORT: could not read crawl_attempts (${error.message}). ` +
            `Refusing to continue — a resumed run would re-fetch rejected pages.`
        );
        stats.blocked = true;
        return stats;
      }
      for (const row of data ?? []) attempted.add(row.url as string);
      if (!data || data.length < 1000) break;
    }
  }

  const queue = candidates.filter(
    (u) => !stored.has(u) && !attempted.has(u)
  );
  stats.alreadyStored = candidates.filter((u) => stored.has(u)).length;
  stats.alreadyAttempted = candidates.filter(
    (u) => !stored.has(u) && attempted.has(u)
  ).length;
  stats.considered = candidates.length;

  if (SAMPLE) {
    for (let i = queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [queue[i], queue[j]] = [queue[j], queue[i]];
    }
  }
  const work = queue.slice(0, LIMIT === Infinity ? queue.length : LIMIT);
  log(
    `  ${stats.found} sitemap URLs -> ${candidates.length} plausible -> ` +
      `${stats.alreadyStored} stored -> ` +
      `${stats.alreadyAttempted} already judged -> ${work.length} to fetch` +
      (RETRY_FAILED ? "  [--retry-failed: skip list ignored]" : "") +
      (DRY_RUN ? "  [DRY RUN — nothing will be written]" : "")
  );

  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const index = cursor++;
      if (index >= work.length) return;
      await processUrl(work[index], domain, stats, tag);

      const done = stats.processed;
      if (done > 0 && done % 25 === 0) {
        log(
          `  [${done}/${work.length}] inserted=${stats.inserted} ` +
            `dupe=${stats.skippedDuplicate} no-jsonld=${stats.skippedNoJsonld} ` +
            `rejected=${rejectedTotal(stats)} failed=${stats.failed}`
        );
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, work.length) }, worker)
  );

  return stats;
}

async function processUrl(
  url: string,
  domain: string,
  stats: DomainStats,
  tag = ""
) {
  await waitForSlot(domain);
  stats.processed++;

  let result;
  try {
    // JSON-LD only. Firing Haiku at thousands of sitemap URLs to salvage
    // pages that mostly aren't recipes is exactly the wrong trade.
    result = await extractRecipe(url, { allowLlmFallback: false });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    stats.failed++;
    logFailure(url, `threw: ${detail}`);
    await recordAttempt(url, domain, "threw", detail);
    return;
  }

  if ("error" in result) {
    if (result.error === "no jsonld") {
      stats.skippedNoJsonld++;
      if (DRY_RUN) console.log(tag + `    no-jsonld  ${url}`);
      await recordAttempt(url, domain, "no_jsonld");
    }
    else {
      stats.failed++;
      if (DRY_RUN) console.log(tag + `    FAIL    ${url}  ${result.error}`);
      logFailure(url, result.error);
      await recordAttempt(url, domain, "fetch_failed", result.error);
    }
    return;
  }

  const { recipe, method, html, jsonld } = result;

  // Section 0 quality gate — before insert, always.
  const rejectReason = qualityCheck(recipe);
  if (rejectReason) {
    stats.rejected[rejectReason] = (stats.rejected[rejectReason] ?? 0) + 1;
    if (stats.rejectedSamples.length < 25) {
      stats.rejectedSamples.push({
        reason: rejectReason,
        title: recipe.title,
        url,
      });
    }
    if (DRY_RUN) {
      console.log(
        tag + `    REJECT  ${recipe.title.slice(0, 52).padEnd(54)}${rejectReason}`
      );
    }
    appendFileSync(
      REJECTED_LOG,
      `${new Date().toISOString()}\t${rejectReason}\t${url}\t${recipe.title}\n`
    );
    // The specific reason, not a flat "rejected" — a domain producing nothing
    // but stub_content is a different problem from one failing the step count.
    await recordAttempt(url, domain, `rejected_${rejectReason}`, recipe.title);
    return;
  }

  const nutrition = parseNutrition(jsonld?.nutrition, recipe.servings);
  if (nutrition.protein_source === "measured") stats.withNutrition++;

  const traces = deriveProteinTraces(recipe.ingredients as never);
  const diet = dietCandidates(recipe.ingredients as never);
  const ANIMAL = ["beef", "pork", "chicken", "fish", "shellfish"];
  if (diet.vegetarian) stats.vegetarian++;
  if (traces.some((t) => ["beef", "pork", "chicken"].includes(t))) stats.meatTrace++;
  if (!traces.some((t) => ANIMAL.includes(t))) stats.noAnimal++;
  for (const t of traces) stats.proteins[t] = (stats.proteins[t] ?? 0) + 1;
  stats.ingredientCounts.push(recipe.ingredients.length);

  if (DRY_RUN) {
    stats.inserted++; // "would insert"
    console.log(
      tag + `    ACCEPT  ${recipe.title.slice(0, 52).padEnd(54)}` +
        `${String(recipe.ingredients.length).padStart(2)} ingr  ` +
        `${String(recipe.steps.length).padStart(2)} steps  ` +
        `${String(recipe.steps.join(" ").length).padStart(5)} chars  ` +
        `${nutrition.protein_source === "measured" ? "nutrition" : "no-nutrition"}`
    );
    return;
  }

  const { error } = await db.from("recipes").insert({
    user_id: null,
    source_url: url,
    source_domain: sourceDomain(url),
    saved: false,
    title: recipe.title,
    image_url: recipe.image_url,
    author: recipe.author,
    total_minutes: recipe.total_minutes,
    servings: recipe.servings,
    ingredients: recipe.ingredients,
    steps: recipe.steps,
    tags: recipe.tags,
    extraction_method: method,
    raw_payload: {
      html_length: html.length,
      extracted_at: new Date().toISOString(),
      jsonld,
    },
  });

  if (error) {
    // A duplicate is a skip, never an abort — this is what keeps a re-run
    // from restarting at zero.
    if (error.code === "23505") {
      stats.skippedDuplicate++;
      await recordAttempt(url, domain, "duplicate");
    } else {
      stats.failed++;
      logFailure(url, `insert: ${error.message}`);
      await recordAttempt(url, domain, "insert_failed", error.message);
    }
    return;
  }

  stats.inserted++;
  await recordAttempt(url, domain, "stored");
}

/**
 * Remembers what happened to a URL so the next run doesn't fetch it again to
 * reach the same conclusion. Upsert, because --retry-failed deliberately
 * re-walks pages that already have a row.
 *
 * Never fatal: failing to record an attempt costs one redundant fetch next
 * time, which is not worth aborting a crawl over.
 */
async function recordAttempt(
  url: string,
  domain: string,
  outcome: string,
  detail?: string
) {
  if (DRY_RUN) return;
  const { error } = await db
    .from("crawl_attempts")
    .upsert(
      {
        url,
        domain,
        outcome,
        detail: detail ? detail.slice(0, 500) : null,
        attempted_at: new Date().toISOString(),
      },
      { onConflict: "url" }
    );
  if (error) {
    console.log(`  (could not record attempt for ${url}: ${error.message})`);
  }
}

function logFailure(url: string, reason: string) {
  appendFileSync(
    FAILURE_LOG,
    `${new Date().toISOString()}\t${url}\t${reason}\n`
  );
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const pct = (n: number, d: number) =>
  d === 0 ? "—" : `${Math.round((n / d) * 100)}%`;

async function main() {
  if (DRY_RUN) {
    console.log(
      "DRY RUN — pages will be fetched and evaluated, nothing written to the database.\n"
    );
  }
  console.log(
    `Domains: ${targets.join(", ")}` +
      (LIMIT === Infinity ? "" : `  |  limit ${LIMIT}/domain`)
  );

  // Fresh decision logs per run so the counts match what you're reading.
  writeFileSync(REJECTED_LOG, `# ${new Date().toISOString()} run\n`);
  writeFileSync(FAILURE_LOG, `# ${new Date().toISOString()} run\n`);

  const parallel = Math.min(DOMAIN_CONCURRENCY, targets.length);
  if (parallel > 1) {
    console.log(
      `Crawling up to ${parallel} domains at once; each domain keeps its own ` +
        `1 req/sec floor.`
    );
  }

  const all: DomainStats[] = new Array(targets.length);
  let nextDomain = 0;
  const domainWorker = async () => {
    for (;;) {
      const i = nextDomain++;
      if (i >= targets.length) return;
      all[i] = await crawlDomain(targets[i], parallel > 1);
    }
  };
  await Promise.all(Array.from({ length: parallel }, domainWorker));

  console.log("\n\n================ SUMMARY ================");
  for (const s of all) {
    console.log(`\n${s.domain}`);
    if (s.blocked) {
      console.log("  SKIPPED — robots.txt disallowed the sitemap");
      continue;
    }
    console.log(`  sitemap URLs found     ${s.found}`);
    console.log(`  plausible recipe URLs  ${s.considered}`);
    console.log(`  already stored         ${s.alreadyStored}`);
    console.log(`  already judged         ${s.alreadyAttempted}  (not re-fetched)`);
    console.log(`  fetched                ${s.processed}`);
    console.log(
      `  ${DRY_RUN ? "would insert" : "inserted"}           ${s.inserted}`
    );
    console.log(`  skipped (duplicate)    ${s.skippedDuplicate}`);
    console.log(`  skipped (no JSON-LD)   ${s.skippedNoJsonld}`);
    console.log(`  rejected (quality)     ${rejectedTotal(s)}`);
    for (const [reason, n] of Object.entries(s.rejected).sort(
      (a, b) => b[1] - a[1]
    )) {
      console.log(`      ${reason.padEnd(22)} ${n}`);
    }
    console.log(`  failed                 ${s.failed}`);
    console.log(
      `  with parseable nutrition  ${s.withNutrition}/${s.inserted}  (${pct(
        s.withNutrition,
        s.inserted
      )})`
    );
  }

  const t = all.reduce(
    (acc, s) => ({
      inserted: acc.inserted + s.inserted,
      rejected: acc.rejected + rejectedTotal(s),
      noJsonld: acc.noJsonld + s.skippedNoJsonld,
      dupe: acc.dupe + s.skippedDuplicate,
      failed: acc.failed + s.failed,
      nutrition: acc.nutrition + s.withNutrition,
    }),
    { inserted: 0, rejected: 0, noJsonld: 0, dupe: 0, failed: 0, nutrition: 0 }
  );

  console.log("\n----------------------------------------");
  console.log(
    `TOTAL  ${DRY_RUN ? "would insert" : "inserted"}=${t.inserted}  ` +
      `rejected=${t.rejected}  no-jsonld=${t.noJsonld}  dupe=${t.dupe}  failed=${t.failed}`
  );
  console.log(
    `       nutrition rate ${t.nutrition}/${t.inserted} (${pct(
      t.nutrition,
      t.inserted
    )})`
  );
  const samples = all.flatMap((s) => s.rejectedSamples);
  if (samples.length) {
    console.log("\n---------- rejected sample ----------");
    const shown = samples.slice(0, 10);
    for (const r of shown) {
      console.log(`  ${r.reason.padEnd(22)} ${r.title.slice(0, 46)}`);
      console.log(`  ${" ".repeat(22)} ${r.url}`);
    }
    if (samples.length > shown.length) {
      console.log(`  ... and ${samples.length - shown.length} more in the log`);
    }
  }

  console.log(`\nrejections: ${REJECTED_LOG}`);
  console.log(`failures:   ${FAILURE_LOG}`);
  if (DRY_RUN) console.log("\nNothing was written. Drop --dry-run to commit.");
}

// Only crawl when executed directly — importing this file for its helpers
// must never hit the network.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
