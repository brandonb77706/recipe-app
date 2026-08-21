import "server-only";
import { supabase } from "./supabase";
import { RANK_COLUMNS, type RankRow } from "./rank";

/**
 * The corpus, held in memory.
 *
 * On serverless this was pointless — instances don't share memory and recycle
 * constantly, so a module-level cache was measured at 7x on the warm path and
 * useless on the cold one, which is the one that matters. On a long-lived Node
 * process it's the whole optimisation: /api/discover currently spends 306ms of
 * its ~505ms fetching ~9,900 rows from Supabase on EVERY request, and a process
 * that stays alive only has to do that once.
 *
 * Design rules, each of which exists to stop a specific failure:
 *
 *   NON-BLOCKING BOOT. The server serves before the corpus is ready; requests
 *   fall back to the per-request sweep. A deploy that 503s for 20 seconds while
 *   loading is worse than one that's briefly slow.
 *
 *   ATOMIC SWAP. A refresh builds a NEW array and reassigns the reference.
 *   Nothing mutates the array a request is iterating.
 *
 *   A FAILED REFRESH KEEPS THE OLD DATA. Marked `stale`, logged, still served.
 *   Losing the corpus to one bad refresh would take the app from fast to broken.
 *
 *   THE FALLBACK NEVER GOES AWAY. If this module is unavailable for any reason
 *   the app degrades to today's behaviour: slower, never wrong.
 */

export type CorpusState = "loading" | "ready" | "stale" | "failed";

export type CorpusStatus = {
  state: CorpusState;
  rowCount: number;
  lastLoadedAt: string | null;
  lastError: string | null;
  /** Milliseconds the most recent successful load took. */
  lastLoadMs: number | null;
  refreshes: number;
};

/** Supabase caps any single response at 1000 rows regardless of .limit(). */
const PAGE = 1000;

/** The corpus only changes when a crawl runs, so this is generous. */
const REFRESH_INTERVAL_MS = 30 * 60 * 1000;

let rows: RankRow[] = [];
let state: CorpusState = "loading";
let lastLoadedAt: number | null = null;
let lastError: string | null = null;
let lastLoadMs: number | null = null;
let refreshes = 0;

/** In-flight load, so concurrent callers share one rather than stampeding. */
let inFlight: Promise<boolean> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

async function fetchAllRows(): Promise<RankRow[]> {
  const { count, error: countError } = await supabase
    .from("recipes")
    .select("*", { count: "exact", head: true })
    .eq("saved", false);
  if (countError) throw new Error(countError.message);

  const pages = Math.max(1, Math.ceil((count ?? 0) / PAGE));
  const results = await Promise.all(
    Array.from({ length: pages }, (_, i) =>
      supabase
        .from("recipes")
        .select(RANK_COLUMNS)
        .eq("saved", false)
        .order("id", { ascending: true })
        .range(i * PAGE, i * PAGE + PAGE - 1)
    )
  );

  const next: RankRow[] = [];
  for (const r of results) {
    // Abort rather than install a partial corpus. A short load would look like
    // a working feed with most of the good recipes missing — the same silent
    // failure the crawler's abort guard exists to prevent.
    if (r.error) throw new Error(r.error.message);
    next.push(...((r.data ?? []) as unknown as RankRow[]));
  }
  if (next.length === 0) throw new Error("corpus load returned zero rows");
  return next;
}

/**
 * Loads or reloads the corpus. Resolves true on success.
 * Never throws — failures are recorded in the status instead.
 */
export async function refreshCorpus(): Promise<boolean> {
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const started = Date.now();
    try {
      const next = await fetchAllRows();
      // Atomic: swap the reference, never mutate what readers hold.
      rows = next;
      state = "ready";
      lastLoadedAt = Date.now();
      lastLoadMs = Date.now() - started;
      lastError = null;
      refreshes++;
      return true;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      // Keep serving whatever we already had.
      state = rows.length > 0 ? "stale" : "failed";
      console.error(`[corpus] refresh failed (${state}): ${lastError}`);
      return false;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/**
 * Starts the initial load and the refresh timer, once per process.
 * Deliberately NOT awaited by callers — that's what keeps boot non-blocking.
 */
export function startCorpus(): void {
  if (timer) return;
  void refreshCorpus();
  timer = setInterval(() => void refreshCorpus(), REFRESH_INTERVAL_MS);
  // Don't hold the process open on account of a cache timer.
  timer.unref?.();
}

/**
 * The rows, or null when there's nothing usable yet.
 *
 * Null is the signal to fall back to the per-request sweep. `stale` still
 * returns rows — out of date by up to a refresh interval beats not working.
 */
export function getCorpusRows(): RankRow[] | null {
  if (state === "ready" || state === "stale") return rows;
  return null;
}

export function corpusStatus(): CorpusStatus {
  return {
    state,
    rowCount: rows.length,
    lastLoadedAt: lastLoadedAt ? new Date(lastLoadedAt).toISOString() : null,
    lastError,
    lastLoadMs,
    refreshes,
  };
}

/** Resident set size in MB — the real number, not an estimate. */
export function processMemoryMb(): number {
  return Math.round((process.memoryUsage().rss / 1024 / 1024) * 10) / 10;
}
