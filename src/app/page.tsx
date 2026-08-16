"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Recipe } from "@/lib/types";
import { RecipeCard } from "@/components/recipe-card";
import { SearchBar } from "@/components/search-bar";
import { isOnboarded, type Preferences } from "@/lib/preferences";
import { DiscoverFilters } from "@/components/discover-filters";
import { NO_CHIPS, chipsToParams, type ChipFilters, type Facets } from "@/lib/filters";

const PAGE_SIZE = 24;

type Status = "checking" | "loading" | "ready" | "error";

export default function Discover() {
  const router = useRouter();
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [status, setStatus] = useState<Status>("checking");
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState(0);
  const [chips, setChips] = useState<ChipFilters>(NO_CHIPS);
  const [facets, setFacets] = useState<Facets | null>(null);
  const [poolSize, setPoolSize] = useState(0);
  const [maxMinutes, setMaxMinutes] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  // Search replaces the feed while a query is active; clearing it restores
  // whatever the feed already had rather than refetching.
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Recipe[] | null>(null);
  const [resultTotal, setResultTotal] = useState(0);
  const [fuzzy, setFuzzy] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [searching, setSearching] = useState(false);

  // Paging position in the ranking, not an array index — exploration picks
  // come from outside the top set, so the two drift apart by design.
  const offset = useRef(0);

  const load = useCallback(
    async (nextOffset: number, active: ChipFilters) => {
      const params = chipsToParams(active);
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(nextOffset));
      const res = await fetch(`/api/discover?${params}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
      return body as {
        recipes: Recipe[];
        candidates: number;
        poolSize: number;
        facets: Facets;
        hasMore?: boolean;
      };
    },
    []
  );

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        // No preferences row at all means we've never asked. Send them to
        // onboarding rather than silently cold-starting the feed forever.
        const prefRes = await fetch("/api/preferences");
        const prefBody = await prefRes.json();
        const prefs: Preferences | null = prefBody?.preferences ?? null;
        if (cancelled) return;
        if (!isOnboarded(prefs)) {
          router.replace("/onboarding");
          return;
        }

        setMaxMinutes(prefs?.max_minutes ?? null);
        setStatus("loading");
        const body = await load(0, chips);
        if (cancelled) return;
        offset.current = body.recipes.length;
        setRecipes(body.recipes);
        setCandidates(body.candidates);
        setPoolSize(body.poolSize ?? body.candidates);
        setFacets(body.facets ?? null);
        setHasMore(body.hasMore ?? false);
        setStatus("ready");
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Something went wrong");
        setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
    };
    // chips is intentionally a dependency: changing one refetches the feed
    // from the top, because the ranking of a narrowed pool is different.
  }, [load, router, chips]);

  // Whether the grid is showing search results or the feed. Derived, not
  // stored — one source of truth for "am I searching" avoids the two drifting.
  /**
   * Mark the card saved where it sits. Deliberately NOT removing it: pulling a
   * tile out from under your thumb reflows everything below and makes the next
   * tap land on the wrong recipe. passesHardFilters already excludes swiped
   * rows, so it disappears on the next fetch, which is the right moment.
   */
  const markSaved = (id: string, saved: boolean) => {
    setRecipes((rs) => rs.map((r) => (r.id === id ? { ...r, saved } : r)));
    setResults((rs) =>
      rs ? rs.map((r) => (r.id === id ? { ...r, saved } : r)) : rs
    );
  };

  const searchMode = query !== "";

  useEffect(() => {
    if (query === "") return;

    let cancelled = false;

    (async () => {
      setSearching(true);
      try {
        const res = await fetch(
          `/api/search?q=${encodeURIComponent(query)}&scope=corpus&limit=48`
        );
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) throw new Error(body?.error ?? "Search failed");
        setResults(body.recipes ?? []);
        setResultTotal(body.total ?? 0);
        setFuzzy(!!body.fuzzy);
        setTruncated(!!body.truncated);
      } catch {
        if (!cancelled) {
          setResults([]);
          setResultTotal(0);
          setFuzzy(false);
          setTruncated(false);
        }
      } finally {
        if (!cancelled) setSearching(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [query]);

  const showMore = async () => {
    if (loadingMore) return;
    setLoadingMore(true);
    try {
      const body = await load(offset.current, chips);
      offset.current += body.recipes.length;
      // De-dupe defensively: an exploration pick can repeat across pages.
      setRecipes((prev) => {
        const seen = new Set(prev.map((r) => r.id));
        return [...prev, ...body.recipes.filter((r) => !seen.has(r.id))];
      });
      setHasMore(body.hasMore ?? false);
    } catch {
      setHasMore(false);
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-6xl px-5 pb-[calc(var(--nav-h)+2rem+env(safe-area-inset-bottom))] sm:px-8">
      {/* Sticky, and deliberately tiny. The page heading and the sentence
          "N recipes match what you're after" together burned 44% of the first
          viewport before a single photo appeared. The count moved into the
          filter row where it's still visible but costs nothing. */}
      <header className="sticky top-0 z-30 -mx-5 mb-3 bg-paper/95 px-5 pt-[calc(0.75rem+env(safe-area-inset-top))] pb-2 backdrop-blur-md sm:-mx-8 sm:px-8">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <SearchBar onChange={setQuery} busy={searching} />
          </div>
          <Link
            href="/settings"
            aria-label="Preferences"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--radius-control)] border border-line bg-surface text-muted transition active:bg-accent-soft"
          >
            <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5">
              <path d="M12 15a3 3 0 100-6 3 3 0 000 6z" stroke="currentColor" strokeWidth="1.6" />
              <path
                d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 008.6 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 8.6a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z"
                stroke="currentColor" strokeWidth="1.6"
              />
            </svg>
          </Link>
        </div>

        {status !== "checking" && !searchMode && (
          <DiscoverFilters
            chips={chips}
            onChange={setChips}
            facets={facets}
            maxMinutes={maxMinutes}
            matching={candidates}
            poolSize={poolSize}
          />
        )}

        {searchMode && status === "ready" && (
          <p className="mt-2 text-sm text-muted figures-text">
            {truncated ? "top " : ""}
            {resultTotal.toLocaleString()} {resultTotal === 1 ? "result" : "results"}
            {fuzzy && results && results.length > 0 ? " — closest spellings" : ""}
          </p>
        )}
      </header>

      {(status === "checking" || status === "loading") && <SkeletonGrid />}

      {status === "error" && (
        <Notice title="Couldn’t load Discover" body={error ?? "Unknown error"} />
      )}

      {status === "ready" && searchMode ? (
        results === null || (searching && results.length === 0) ? (
          <SkeletonGrid />
        ) : results.length === 0 ? (
          <Notice
            title="No matches"
            body={`Nothing in the corpus matches “${query}”. Try a dish name, an ingredient, or something like “meal prep”.`}
          />
        ) : (
          <ul className="grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3 lg:grid-cols-4">
            {results.map((recipe, i) => (
              <li key={recipe.id}>
                <RecipeCard
                  recipe={recipe}
                  eager={i < 4}
                  dense
                  showSave
                  onSavedChange={(saved) => markSaved(recipe.id, saved)}
                />
              </li>
            ))}
          </ul>
        )
      ) : null}

      {status === "ready" &&
        !searchMode &&
        (recipes.length === 0 ? (
          <Notice
            title="Nothing left to show"
            body="Your filters are narrow enough that the corpus is exhausted. Loosening the time limit in Preferences is usually the quickest fix."
          />
        ) : (
          <>
            <ul className="grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3 lg:grid-cols-4">
              {recipes.map((recipe, i) => (
                <li key={recipe.id}>
                  <RecipeCard
                  recipe={recipe}
                  eager={i < 4}
                  dense
                  showSave
                  onSavedChange={(saved) => markSaved(recipe.id, saved)}
                />
                </li>
              ))}
            </ul>

            {hasMore && (
              <div className="mt-10 flex justify-center">
                <button
                  type="button"
                  onClick={showMore}
                  disabled={loadingMore}
                  className="h-13 rounded-2xl border border-line bg-surface px-7 text-base font-semibold transition active:bg-accent-soft disabled:opacity-40"
                >
                  {loadingMore ? "Loading…" : "Show more"}
                </button>
              </div>
            )}
          </>
        ))}
    </div>
  );
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-line px-6 py-16 text-center">
      <p className="font-display text-2xl font-semibold">{title}</p>
      <p className="mx-auto mt-2 max-w-sm text-base text-muted">{body}</p>
    </div>
  );
}

function SkeletonGrid() {
  return (
    <ul
      className="grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3 lg:grid-cols-4"
      aria-label="Loading recipes"
    >
      {Array.from({ length: 6 }).map((_, i) => (
        <li
          key={i}
          className="overflow-hidden rounded-2xl bg-surface ring-1 ring-line"
        >
          <div className="aspect-[16/10] animate-pulse bg-line/60" />
          <div className="space-y-2.5 px-5 py-5">
            <div className="h-4 w-4/5 animate-pulse rounded bg-line/60" />
            <div className="h-4 w-1/3 animate-pulse rounded bg-line/60" />
          </div>
        </li>
      ))}
    </ul>
  );
}
