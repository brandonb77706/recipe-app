"use client";

import { useState } from "react";
import { refreshOfflineCache } from "@/components/offline";

/**
 * The one save control, used by discover cards and the recipe detail page.
 *
 * Goes through POST /api/swipe with direction 'right' rather than a second
 * save endpoint. That route already flips `saved` and claims `user_id`, and
 * routing through it means a save from Discover produces exactly the same
 * taste signal as a right-swipe — two ways to say "I want this" that teach the
 * ranker the same thing. A separate save path would silently make the profile
 * blind to half of what you keep.
 *
 * Untapping issues the matching DELETE, which removes the swipe row as well as
 * un-saving. Flipping `saved` alone would leave the swipe behind and the
 * recipe would stay permanently invisible to Discover with no way back.
 */
export function SaveButton({
  recipeId,
  initialSaved,
  onChange,
  size = "card",
}: {
  recipeId: string;
  initialSaved: boolean;
  /** Fired after a successful toggle, so the page can update counts. */
  onChange?: (saved: boolean) => void;
  size?: "card" | "detail" | "dense";
}) {
  const [saved, setSaved] = useState(initialSaved);
  const [busy, setBusy] = useState(false);

  const toggle = async (e: React.MouseEvent) => {
    // The card is a link; saving must not navigate.
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;

    const next = !saved;
    setSaved(next); // optimistic — the tap should feel instant
    setBusy(true);

    try {
      const res = next
        ? await fetch("/api/swipe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ recipe_id: recipeId, direction: "right" }),
          })
        : await fetch("/api/swipe", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ recipe_id: recipeId }),
          });

      if (!res.ok) throw new Error();
      onChange?.(next);
      if (next) refreshOfflineCache();
    } catch {
      setSaved(!next); // put it back — the button was lying
    } finally {
      setBusy(false);
    }
  };

  const detail = size === "detail";
  const dense = size === "dense";

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={saved}
      aria-label={saved ? "Remove from library" : "Save to library"}
      className={
        detail
          ? `flex h-12 items-center gap-2 rounded-full border px-5 text-base font-semibold transition active:scale-95 ${
              saved
                ? "border-accent bg-accent text-white"
                : "border-accent bg-surface text-accent"
            }`
          : `absolute flex items-center justify-center rounded-full backdrop-blur-sm transition active:scale-90 ${
              dense ? "top-1.5 right-1.5 h-8 w-8" : "top-3 right-3 h-11 w-11"
            } ${saved ? "bg-accent text-white" : "bg-black/40 text-white"}`
      }
    >
      <svg
        viewBox="0 0 24 24"
        className={detail ? "h-5 w-5" : dense ? "h-4 w-4" : "h-6 w-6"}
        fill={saved ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      >
        <path d="M12 20s-7-4.5-7-9.5A3.9 3.9 0 0112 8a3.9 3.9 0 017 2.5c0 5-7 9.5-7 9.5z" />
      </svg>
      {detail && (saved ? "Saved" : "Save")}
    </button>
  );
}
