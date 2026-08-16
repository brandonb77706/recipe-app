"use client";

import { useCallback, useEffect, useState } from "react";
import type { Recipe } from "@/lib/types";
import { formatIngredient } from "@/lib/format";

/**
 * Keeps the screen awake while cooking. Degrades silently everywhere the API
 * is missing or denied — Safari support is inconsistent and this must never
 * be the reason cook mode breaks.
 */
function useWakeLock() {
  useEffect(() => {
    let lock: WakeLockSentinel | null = null;
    let cancelled = false;

    const acquire = async () => {
      try {
        if ("wakeLock" in navigator) {
          lock = await navigator.wakeLock.request("screen");
          if (cancelled) {
            lock.release();
            lock = null;
          }
        }
      } catch {
        /* unsupported or denied — degrade silently */
      }
    };

    acquire();

    // iOS drops the lock when the tab is backgrounded; re-acquire on return
    const onVisible = () => {
      if (document.visibilityState === "visible" && !lock) acquire();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      lock?.release();
    };
  }, []);
}

export function CookMode({
  recipe,
  scale,
  checked,
  onToggle,
  onExit,
}: {
  recipe: Recipe;
  scale: number;
  checked: Set<number>;
  onToggle: (index: number) => void;
  onExit: () => void;
}) {
  const [index, setIndex] = useState(0);

  useWakeLock();

  const total = recipe.steps.length;
  const remaining = recipe.ingredients.length - checked.size;
  const nextUnchecked = recipe.ingredients.findIndex((_, i) => !checked.has(i));
  const next = useCallback(
    () => setIndex((i) => Math.min(total - 1, i + 1)),
    [total]
  );
  const back = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);

  // Lock background scrolling while the overlay is up.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") next();
      else if (e.key === "ArrowLeft") back();
      else if (e.key === "Escape") onExit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next, back, onExit]);

  // Collapsed by default. Docked-open cost ~500px on a phone and cut the
  // instruction off mid-sentence — the step is the point, ingredients are the
  // glance. Collapsed still shows the next unchecked item and a count.
  const [sheetOpen, setSheetOpen] = useState(false);

  return (
    <div
      // Near-black rather than pure black so the screen edge isn't a hard seam
      // against the bezel. Three zones, each shrink-0 except the middle, so
      // nothing can overlap anything else at any height.
      className="fixed inset-0 z-50 flex flex-col bg-[#0f0d0c] text-white"
      style={{
        paddingTop: "env(safe-area-inset-top)",
        paddingLeft: "env(safe-area-inset-left)",
        paddingRight: "env(safe-area-inset-right)",
      }}
      role="dialog"
      aria-modal="true"
      aria-label={`Cook mode: ${recipe.title}`}
    >
      <header className="flex shrink-0 items-center justify-between px-5 pt-2 pb-1.5">
        <p className="figures-tabular text-[19px] leading-none font-semibold">
          <span className="text-white">{index + 1}</span>
          <span className="text-white/35"> / {total}</span>
        </p>
        <button
          type="button"
          onClick={onExit}
          className="-mr-2 flex h-10 items-center px-4 text-[16px] font-medium text-white/55 transition active:text-white"
        >
          Done
        </button>
      </header>

      {/* One continuous bar, not one dash per step — at arm's length dashes
          read as texture. shrink-0 so it can never be overlapped by the step. */}
      <div className="mx-5 mb-1 h-1.5 shrink-0 overflow-hidden rounded-full bg-white/12">
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-300"
          style={{ width: `${((index + 1) / total) * 100}%` }}
        />
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col">
        {/* The scroll container centres its child via an inner min-h-full flex
            rather than `items-center` on itself. Centring the scroller
            directly pushes overflowing content past the top edge where
            scrolling can't reach it — that's what clipped the first line. */}
        <div
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
          // Fades the last line when a step is long enough to scroll. Short
          // steps are vertically centred and never reach the fade, so this
          // costs nothing in the common case and is the only cue that there's
          // more text in the rare one — the longest step in the corpus is 495
          // characters and needs about two lines more than a 620px screen has.
          style={{
            maskImage:
              "linear-gradient(to bottom, black calc(100% - 2.5rem), transparent)",
            WebkitMaskImage:
              "linear-gradient(to bottom, black calc(100% - 2.5rem), transparent)",
          }}
        >
          <div className="flex min-h-full items-center px-5 py-4">
            <p
              className="leading-[1.3] font-medium text-balance"
              // Scales with the viewport: a whole instruction on screen beats
              // slightly larger type you have to scroll through.
              style={{ fontSize: "clamp(1.375rem, 5.4vw, 2.5rem)" }}
            >
              {recipe.steps[index]}
            </p>
          </div>
        </div>

        {/* Expanded ingredients overlay the step rather than compressing it. */}
        {sheetOpen && (
          <>
            <button
              type="button"
              aria-label="Close ingredients"
              onClick={() => setSheetOpen(false)}
              className="absolute inset-0 z-10 bg-black/50"
            />
            <ul className="absolute inset-x-0 bottom-0 z-20 max-h-full overflow-y-auto overscroll-contain rounded-t-2xl border-t border-white/12 bg-[#181514] px-5 pt-2 pb-3">
              {recipe.ingredients.map((ingredient, i) => (
                <IngredientRow
                  key={i}
                  text={formatIngredient(ingredient, scale)}
                  checked={checked.has(i)}
                  onToggle={() => onToggle(i)}
                />
              ))}
            </ul>
          </>
        )}
      </div>

      {/* Always-visible ingredient bar: the glance, without leaving the step. */}
      <button
        type="button"
        onClick={() => setSheetOpen((v) => !v)}
        aria-expanded={sheetOpen}
        className="flex h-11 shrink-0 items-center gap-3 border-t border-white/12 bg-white/[0.04] px-5 text-left"
      >
        <span className="shrink-0 text-[12px] font-semibold tracking-wide text-white/45 uppercase">
          Ingredients
        </span>
        {!sheetOpen && nextUnchecked >= 0 && (
          <span className="min-w-0 flex-1 truncate text-[14px] text-white/70">
            {formatIngredient(recipe.ingredients[nextUnchecked], scale)}
          </span>
        )}
        <span className="figures-tabular ml-auto shrink-0 text-[12px] text-white/45">
          {remaining} left
        </span>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          className={`h-4 w-4 shrink-0 text-white/45 transition-transform ${sheetOpen ? "rotate-180" : ""}`}
        >
          <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      <footer
        className="flex shrink-0 gap-2.5 px-4 pt-2.5"
        style={{ paddingBottom: "calc(0.625rem + env(safe-area-inset-bottom))" }}
      >
        <button
          type="button"
          onClick={back}
          disabled={index === 0}
          aria-label="Previous step"
          className="flex h-[64px] w-[64px] shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-white/10 text-white transition active:bg-white/20 disabled:opacity-25"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="h-6 w-6">
            <path d="M15 5l-7 7 7 7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        {/* The one enormous target, and the only terracotta on the screen. */}
        <button
          type="button"
          onClick={index === total - 1 ? onExit : next}
          className="h-[64px] flex-1 rounded-[var(--radius-control)] bg-accent text-[20px] font-semibold text-white transition active:opacity-90"
        >
          {index === total - 1 ? "Finish" : "Next step"}
        </button>
      </footer>
    </div>
  );
}

function IngredientRow({
  text,
  checked,
  onToggle,
}: {
  text: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={checked}
        className="flex w-full items-start gap-3 py-2.5 text-left"
      >
        <span
          className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded border-2 transition ${
            checked ? "border-accent bg-accent" : "border-white/30"
          }`}
        >
          {checked && (
            <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3.5" className="h-3.5 w-3.5" aria-hidden>
              <path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </span>
        <span className={`text-[16px] leading-snug ${checked ? "text-white/30 line-through" : "text-white/90"}`}>
          {text}
        </span>
      </button>
    </li>
  );
}

