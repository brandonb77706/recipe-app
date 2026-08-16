"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import type { Recipe } from "@/lib/types";
import { formatMinutes, formatIngredient } from "@/lib/format";
import { RecipeImage } from "@/components/recipe-image";
import { CookMode } from "@/components/cook-mode";
import { CookingHistory } from "@/components/cooking-history";
import { SaveButton } from "@/components/save-button";

type Status = "loading" | "ready" | "missing" | "error";

export default function RecipeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [recipe, setRecipe] = useState<Recipe | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);

  const [checked, setChecked] = useState<Set<number>>(new Set());
  // Display-only. Never written back to the database.
  const [servings, setServings] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [cooking, setCooking] = useState(false);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setStatus("loading");
      try {
        const res = await fetch(`/api/recipes/${id}`);
        if (res.status === 404) {
          if (!cancelled) setStatus("missing");
          return;
        }
        const body = await res.json();
        if (!res.ok)
          throw new Error(body?.error ?? `Request failed (${res.status})`);
        if (cancelled) return;
        setRecipe(body.recipe);
        // ?cook=1 from a library card jumps straight into cook mode. Read
        // here rather than via useSearchParams, which would force a Suspense
        // boundary around a page that's already client-rendered anyway.
        if (
          typeof window !== "undefined" &&
          new URLSearchParams(window.location.search).get("cook") === "1" &&
          body.recipe?.steps?.length
        ) {
          setCooking(true);
        }
        setServings(body.recipe?.servings ?? null);
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
  }, [id]);

  const toggle = (index: number) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });

  const handleDelete = async () => {
    if (!recipe) return;
    // No longer destructive — the row returns to the corpus and can be
    // rediscovered, so this doesn't need a scary confirmation.
    if (
      !window.confirm(
        `Remove “${recipe.title}” from your library? It'll show up in Discover again.`
      )
    )
      return;

    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/recipes/${recipe.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `Delete failed (${res.status})`);
      }
      router.push("/library");
      router.refresh();
    } catch (e) {
      setDeleting(false);
      setError(e instanceof Error ? e.message : "Could not delete this recipe");
    }
  };

  if (status === "loading") return <DetailSkeleton />;

  if (status === "missing" || status === "error" || !recipe) {
    return (
      <Message
        title={status === "missing" ? "Recipe not found" : "Couldn’t load recipe"}
        body={
          status === "missing"
            ? "It may have been deleted."
            : (error ?? "Unknown error")
        }
      />
    );
  }

  // Scale factor is meaningless without an original serving count, which is
  // why the control is hidden entirely in that case.
  const scale =
    recipe.servings && servings ? servings / recipe.servings : 1;

  const time = formatMinutes(recipe.total_minutes);
  const subhead = [recipe.author, time].filter(Boolean).join(" · ");

  return (
    <article className="pb-[calc(7rem+env(safe-area-inset-bottom))]">
      <div className="relative">
        <RecipeImage
          src={recipe.image_url}
          title={recipe.title}
        generated={recipe.extraction_method === "llm_generated"}
          eager
          className="aspect-[4/3] w-full sm:aspect-[16/7]"
        />
        <Link
          href={recipe.saved ? "/library" : "/"}
          aria-label={recipe.saved ? "Back to library" : "Back to Discover"}
          className="absolute top-[calc(1rem+env(safe-area-inset-top))] left-4 flex h-11 w-11 items-center justify-center rounded-full bg-surface/90 shadow-sm backdrop-blur transition hover:bg-surface"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-5 w-5"
            aria-hidden="true"
          >
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </Link>
      </div>

      <div className="mx-auto max-w-2xl px-5 sm:px-8">
        <header className="pt-7">
          <h1 className="font-display text-3xl leading-tight font-semibold text-balance sm:text-4xl">
            {recipe.title}
          </h1>
          {subhead && <p className="mt-3 text-base text-muted">{subhead}</p>}
        </header>

        {recipe.steps.length > 0 && (
          <button
            type="button"
            onClick={() => setCooking(true)}
            className="mt-7 flex h-14 w-full items-center justify-center rounded-2xl bg-accent text-lg font-semibold text-white transition active:opacity-90"
          >
            Start cooking
          </button>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-3">
          {/* First in the row and full-height: this is the primary action on
              an unsaved recipe, and it has to be thumb-reachable. */}
          <SaveButton
            recipeId={recipe.id}
            initialSaved={recipe.saved}
            size="detail"
            onChange={(saved) =>
              setRecipe((r) => (r ? { ...r, saved } : r))
            }
          />
          <a
            href={recipe.source_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-11 items-center rounded-full border border-line bg-surface px-5 text-base font-medium transition hover:border-accent hover:text-accent"
          >
            View original
          </a>
          {recipe.saved && (
            <button
              type="button"
              onClick={handleDelete}
              disabled={deleting}
              className="inline-flex h-11 items-center rounded-full border border-line bg-surface px-5 text-base font-medium text-muted transition hover:border-accent hover:text-accent disabled:opacity-50"
            >
              {deleting ? "Removing…" : "Remove from library"}
            </button>
          )}
        </div>

        {error && status === "ready" && (
          <p className="mt-4 text-base text-accent">{error}</p>
        )}

        {recipe.servings != null && servings != null && (
          <div className="mt-8 flex items-center justify-between rounded-2xl bg-surface px-5 py-4 ring-1 ring-line">
            <div>
              <p className="text-base font-medium">Servings</p>
              {servings !== recipe.servings && (
                <p className="mt-0.5 text-base text-muted">
                  Scaled from {recipe.servings}
                </p>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <StepButton
                label="Fewer servings"
                onClick={() => setServings((s) => Math.max(1, (s ?? 1) - 1))}
                disabled={servings <= 1}
              >
                −
              </StepButton>
              <span className="w-9 text-center text-lg font-medium tabular-nums">
                {servings}
              </span>
              <StepButton
                label="More servings"
                onClick={() => setServings((s) => Math.min(99, (s ?? 1) + 1))}
                disabled={servings >= 99}
              >
                +
              </StepButton>
            </div>
          </div>
        )}

        <section className="mt-10">
          <h2 className="font-display text-2xl font-semibold">Ingredients</h2>
          <ul className="mt-4 divide-y divide-line/70 border-y border-line/70">
            {recipe.ingredients.map((ingredient, i) => {
              const isChecked = checked.has(i);
              return (
                <li key={i}>
                  <button
                    type="button"
                    onClick={() => toggle(i)}
                    aria-pressed={isChecked}
                    className="flex w-full items-start gap-3.5 py-3.5 text-left"
                  >
                    <span
                      className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border transition ${
                        isChecked
                          ? "border-accent bg-accent"
                          : "border-line bg-surface"
                      }`}
                    >
                      {isChecked && (
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="white"
                          strokeWidth="3"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className="h-3.5 w-3.5"
                          aria-hidden="true"
                        >
                          <path d="M20 6L9 17l-5-5" />
                        </svg>
                      )}
                    </span>
                    <span
                      className={`text-base leading-relaxed transition ${
                        isChecked ? "text-muted line-through" : ""
                      }`}
                    >
                      {formatIngredient(ingredient, scale)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="mt-11">
          <h2 className="font-display text-2xl font-semibold">Steps</h2>
          <ol className="mt-5 space-y-6">
            {recipe.steps.map((step, i) => (
              <li key={i} className="flex gap-4">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-soft font-display text-base font-semibold text-accent">
                  {i + 1}
                </span>
                <p className="pt-0.5 text-[17px] leading-relaxed">{step}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* Library only. A corpus row you haven't saved has no history to
            keep, and offering the form would imply otherwise. */}
        {recipe.saved && <CookingHistory recipeId={recipe.id} />}
      </div>

      {cooking && (
        <CookMode
          recipe={recipe}
          scale={scale}
          checked={checked}
          onToggle={toggle}
          onExit={() => setCooking(false)}
        />
      )}
    </article>
  );
}

function StepButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="flex h-11 w-11 items-center justify-center rounded-full border border-line bg-paper text-xl leading-none transition hover:border-accent hover:text-accent disabled:opacity-35 disabled:hover:border-line disabled:hover:text-ink"
    >
      {children}
    </button>
  );
}

function Message({ title, body }: { title: string; body: string }) {
  return (
    <div className="mx-auto max-w-2xl px-5 py-24 text-center">
      <p className="font-display text-2xl font-semibold">{title}</p>
      <p className="mt-2 text-base text-muted">{body}</p>
      <Link
        href="/"
        className="mt-7 inline-flex h-11 items-center rounded-full border border-line bg-surface px-5 text-base font-medium transition hover:border-accent hover:text-accent"
      >
        Back to Discover
      </Link>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="pb-28">
      <div className="aspect-[4/3] w-full animate-pulse bg-line/60 sm:aspect-[16/7]" />
      <div className="mx-auto max-w-2xl px-5 pt-7 sm:px-8">
        <div className="h-9 w-3/4 animate-pulse rounded bg-line/60" />
        <div className="mt-3 h-5 w-1/3 animate-pulse rounded bg-line/60" />
        <div className="mt-10 space-y-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="h-5 w-full animate-pulse rounded bg-line/60"
            />
          ))}
        </div>
      </div>
    </div>
  );
}
