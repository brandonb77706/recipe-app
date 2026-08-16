"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { Recipe } from "@/lib/types";
import { RecipeImage } from "@/components/recipe-image";
import { formatMinutes } from "@/lib/format";

/**
 * Recipes you swiped left on.
 *
 * Deliberately not in the main nav — this is a recovery screen, not somewhere
 * to browse. It exists because a left swipe is otherwise permanent: Discover
 * excludes everything swiped, so a mis-swipe removes a recipe from the app
 * forever with no way back.
 *
 * A list rather than the card grid, on purpose. You're scanning for one thing
 * you regret, not shopping.
 */
export default function Passed() {
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/passed?limit=200");
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
        if (cancelled) return;
        setRecipes(body.recipes ?? []);
        setTotal(body.total ?? 0);
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
  }, []);

  const unpass = async (recipe: Recipe) => {
    setRestoring((s) => new Set(s).add(recipe.id));
    try {
      // Same endpoint the swipe deck's undo uses — deleting the swipe row is
      // what makes the recipe visible to Discover again.
      const res = await fetch("/api/swipe", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipe_id: recipe.id }),
      });
      if (!res.ok) throw new Error();
      setRecipes((rs) => rs.filter((r) => r.id !== recipe.id));
      setTotal((t) => Math.max(0, t - 1));
    } catch {
      setError("Couldn’t restore that one. Check your connection.");
    } finally {
      setRestoring((s) => {
        const next = new Set(s);
        next.delete(recipe.id);
        return next;
      });
    }
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-5 pt-[calc(2.5rem+env(safe-area-inset-top))] pb-[calc(var(--nav-h)+2rem+env(safe-area-inset-bottom))] sm:px-8">
      <header className="mb-8">
        <Link
          href="/library"
          className="text-base text-muted transition active:opacity-60"
        >
          ← Library
        </Link>
        <h1 className="mt-4 font-display text-4xl font-semibold tracking-tight">
          Passed
        </h1>
        <p className="mt-2 max-w-lg text-base text-muted">
          {total > 0
            ? `${total.toLocaleString()} ${
                total === 1 ? "recipe" : "recipes"
              } you swiped past. Restoring one puts it back in Discover.`
            : "Recipes you swipe left on land here, in case you change your mind."}
        </p>
      </header>

      {status === "loading" && (
        <ul className="space-y-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <li key={i} className="flex gap-4">
              <div className="h-20 w-28 shrink-0 animate-pulse rounded-xl bg-line/60" />
              <div className="flex-1 space-y-2 py-2">
                <div className="h-4 w-3/4 animate-pulse rounded bg-line/60" />
                <div className="h-4 w-1/3 animate-pulse rounded bg-line/60" />
              </div>
            </li>
          ))}
        </ul>
      )}

      {status === "error" && (
        <Notice title="Couldn’t load your passed recipes" body={error ?? ""} />
      )}

      {status === "ready" && recipes.length === 0 && (
        <Notice
          title="Nothing passed yet"
          body="Swipe left on something and it'll show up here."
        />
      )}

      {error && status === "ready" && (
        <p className="mb-4 text-base text-accent">{error}</p>
      )}

      {recipes.length > 0 && (
        <ul className="space-y-3">
          {recipes.map((recipe) => {
            const time = formatMinutes(recipe.total_minutes);
            const busy = restoring.has(recipe.id);
            return (
              <li
                key={recipe.id}
                className="flex items-center gap-4 rounded-2xl border border-line bg-surface p-3"
              >
                <Link
                  href={`/recipe/${recipe.id}`}
                  className="shrink-0 overflow-hidden rounded-xl"
                >
                  <RecipeImage
                    src={recipe.image_url}
                    title={recipe.title}
                    generated={recipe.extraction_method === "llm_generated"}
                    className="h-20 w-28"
                  />
                </Link>

                <div className="min-w-0 flex-1">
                  <Link href={`/recipe/${recipe.id}`} className="block">
                    <h2 className="font-display text-lg leading-snug font-semibold text-balance">
                      {recipe.title}
                    </h2>
                  </Link>
                  <p className="mt-1 text-base text-muted">
                    {[recipe.source_domain, time].filter(Boolean).join(" · ")}
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => unpass(recipe)}
                  disabled={busy}
                  className="h-11 shrink-0 rounded-[var(--radius-control)] border border-line bg-surface px-4 text-base font-medium text-ink transition active:bg-accent-soft disabled:opacity-40"
                >
                  {busy ? "…" : "Restore"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
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
