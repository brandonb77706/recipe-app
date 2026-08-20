"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { Recipe } from "@/lib/types";
import { RecipeCard } from "@/components/recipe-card";
import { SearchBar } from "@/components/search-bar";
import { SkeletonGrid } from "@/components/skeletons";
import { LibraryControls } from "@/components/library-controls";
import { EMPTY_QUERY, type LibraryQuery } from "@/lib/library";

type Status = "loading" | "ready" | "error";

export default function Home() {
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);

  // Bumped after an import to refetch without flashing the skeleton back in.
  const [reloadToken, setReloadToken] = useState(0);

  const [query, setQuery] = useState("");
  const [libQuery, setLibQuery] = useState<LibraryQuery>(EMPTY_QUERY);
  const [importOpen, setImportOpen] = useState(false);
  // Kept so the filter line can say "12 of 40" — the filtered fetch can't
  // report a total it deliberately excluded.
  const [total, setTotal] = useState<number | null>(null);
  const [results, setResults] = useState<Recipe[] | null>(null);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const params = new URLSearchParams({ sort: libQuery.sort });
        if (libQuery.cooked) params.set("cooked", libQuery.cooked);
        if (libQuery.mealType) params.set("meal_type", libQuery.mealType);

        const res = await fetch(`/api/recipes?${params}`);
        const body = await res.json();
        if (!res.ok)
          throw new Error(body?.error ?? `Request failed (${res.status})`);
        if (cancelled) return;
        setRecipes(body.recipes ?? []);
        // The unfiltered count only needs fetching when a filter is on.
        if (!libQuery.cooked && !libQuery.mealType) {
          setTotal((body.recipes ?? []).length);
        }
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
  }, [reloadToken, libQuery]);

  const searchMode = query !== "";

  useEffect(() => {
    if (query === "") return;

    let cancelled = false;

    (async () => {
      setSearching(true);
      try {
        const res = await fetch(
          `/api/search?q=${encodeURIComponent(query)}&scope=library&limit=60`
        );
        const body = await res.json();
        if (cancelled) return;
        setResults(res.ok ? (body.recipes ?? []) : []);
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [query]);

  const shown = searchMode ? (results ?? []) : recipes;

  return (
    <div className="mx-auto w-full max-w-6xl px-5 pt-[calc(1rem+env(safe-area-inset-top))] pb-[calc(var(--nav-h)+2rem+env(safe-area-inset-bottom))] sm:px-8">
      {/* Same treatment as Discover: search and controls pin to the top, the
          page heading is gone, and importing hides behind a button. Browsing
          what you already have is the job here; importing is occasional. */}
      <header className="sticky top-0 z-30 -mx-5 mb-3 bg-paper/95 px-5 pt-[calc(0.75rem+env(safe-area-inset-top))] pb-2 backdrop-blur-md sm:-mx-8 sm:px-8">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <SearchBar
              onChange={setQuery}
              placeholder="Search your library"
              busy={searching}
            />
          </div>
          <button
            type="button"
            onClick={() => setImportOpen((v) => !v)}
            aria-label={importOpen ? "Close import" : "Import a recipe"}
            aria-expanded={importOpen}
            className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--radius-control)] border transition ${
              importOpen
                ? "border-accent bg-accent text-white"
                : "border-line bg-surface text-muted active:bg-accent-soft"
            }`}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5">
              <path d="M12 5v14M5 12h14" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Rendered during loading too. Gating this on status === "ready"
            meant the grid started 60-80px too high and everything jumped down
            when data landed — the sort/filter row doesn't depend on the fetch
            for its shape, only for its counts. */}
        {!searchMode && status !== "error" && (
          <LibraryControls
            query={libQuery}
            onChange={setLibQuery}
            total={total ?? recipes.length}
            showing={recipes.length}
            loading={status === "loading"}
          />
        )}
      </header>

      {importOpen && (
        <div className="mb-4">
          <ImportForm
            onImported={() => {
              setReloadToken((t) => t + 1);
              setImportOpen(false);
            }}
          />
        </div>
      )}

      {status === "loading" && <SkeletonGrid />}

      {status === "error" && (
        <Notice
          title="Couldn’t load your recipes"
          body={error ?? "Unknown error"}
        />
      )}

      {status === "ready" &&
        (recipes.length === 0 ? (
          <Notice
            title={
              libQuery.cooked || libQuery.mealType
                ? "Nothing matches those filters"
                : "No recipes yet"
            }
            body={
              libQuery.cooked || libQuery.mealType
                ? "Clear a filter to see the rest of your library."
                : "Import one from a recipe URL and it’ll show up here."
            }
          />
        ) : searchMode && shown.length === 0 ? (
          <Notice
            title="No matches"
            body={`Nothing in your library matches “${query}”.`}
          />
        ) : (
          <ul className="grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3 lg:grid-cols-4">
            {shown.map((recipe) => (
              <li key={recipe.id}>
                <RecipeCard
                  recipe={recipe}
                  dense
                  showLibraryActions
                  onRemoved={(id) =>
                    setRecipes((rs) => rs.filter((r) => r.id !== id))
                  }
                />
              </li>
            ))}
          </ul>
        ))}
      {status === "ready" && (
        <p className="mt-8 text-center">
          <Link
            href="/passed"
            className="text-base text-muted underline underline-offset-4 transition active:opacity-60"
          >
            Passed recipes
          </Link>
        </p>
      )}
    </div>
  );
}

function ImportForm({ onImported }: { onImported: () => void }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !url.trim()) return;

    setBusy(true);
    setError(null);
    setNote(null);

    try {
      const res = await fetch("/api/import-ui", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const body = await res.json().catch(() => null);

      if (!res.ok) {
        setError(body?.error ?? `Import failed (${res.status}).`);
        return;
      }

      setUrl("");
      setNote(
        body?.cached
          ? `“${body.recipe.title}” was already saved.`
          : `Saved “${body?.recipe?.title ?? "recipe"}”.`
      );
      onImported();
    } catch {
      setError("Couldn’t reach the server. Check your connection.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="mb-9">
      <div className="flex flex-col gap-3 sm:flex-row">
        <input
          type="url"
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Paste a recipe link"
          disabled={busy}
          className="h-12 w-full min-w-0 rounded-[var(--radius-control)] border border-line bg-surface px-4 text-base outline-none transition placeholder:text-muted/70 focus:border-accent disabled:opacity-60 sm:flex-1"
        />
        <button
          type="submit"
          disabled={busy || !url.trim()}
          className="flex h-12 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-accent px-6 text-base font-semibold text-white transition active:opacity-90 disabled:bg-line disabled:text-muted"
        >
          {busy ? "Importing…" : "Import"}
        </button>
      </div>

      {busy && (
        <p className="mt-3 text-base text-muted">
          Fetching and reading the page — this takes a few seconds.
        </p>
      )}
      {error && <p className="mt-3 text-base text-accent">{error}</p>}
      {note && !error && <p className="mt-3 text-base text-muted">{note}</p>}
    </form>
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

