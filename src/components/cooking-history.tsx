"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  COOK_RATINGS,
  RATING_HINTS,
  RATING_LABELS,
  relativeDate,
  type Cook,
  type CookRating,
  type RecipeNote,
} from "@/lib/cooking";

/**
 * The cook log and the standing note, for a library recipe.
 *
 * Two separate things on purpose, and the UI keeps them visibly separate: the
 * log is history you add to, the note is one thing you rewrite. Merging them
 * into a single "notes" box would mean either losing the history or retyping
 * the note every time you cooked.
 */
export function CookingHistory({ recipeId }: { recipeId: string }) {
  const [cooks, setCooks] = useState<Cook[]>([]);
  const [note, setNote] = useState("");
  const [savedNote, setSavedNote] = useState("");
  const [loading, setLoading] = useState(true);
  const [logging, setLogging] = useState(false);
  const [noteState, setNoteState] = useState<"idle" | "saving" | "saved">("idle");

  // Draft state for the log form.
  const [rating, setRating] = useState<CookRating | null>(null);
  const [cookNote, setCookNote] = useState("");
  const [expanded, setExpanded] = useState(false);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [cooksRes, noteRes] = await Promise.all([
          fetch(`/api/recipes/${recipeId}/cooks`),
          fetch(`/api/recipes/${recipeId}/note`),
        ]);
        const cooksBody = await cooksRes.json();
        const noteBody = await noteRes.json();
        if (cancelled) return;
        setCooks(cooksBody.cooks ?? []);
        const existing: RecipeNote | null = noteBody.note ?? null;
        setNote(existing?.note ?? "");
        setSavedNote(existing?.note ?? "");
      } catch {
        // Non-fatal: the recipe is still readable without its history.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [recipeId]);

  const logCook = async () => {
    if (logging) return;
    setLogging(true);
    try {
      const res = await fetch(`/api/recipes/${recipeId}/cooks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating, note: cookNote }),
      });
      const body = await res.json();
      if (res.ok && body.cook) {
        setCooks((c) => [body.cook, ...c]);
        setRating(null);
        setCookNote("");
        setExpanded(false);
      }
    } finally {
      setLogging(false);
    }
  };

  const saveNote = useCallback(
    async (text: string) => {
      setNoteState("saving");
      try {
        await fetch(`/api/recipes/${recipeId}/note`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ note: text }),
        });
        setSavedNote(text.trim());
        setNoteState("saved");
      } catch {
        setNoteState("idle");
      }
    },
    [recipeId]
  );

  const onNoteChange = (text: string) => {
    setNote(text);
    setNoteState("saving");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void saveNote(text), 700);
  };

  if (loading) {
    return (
      <section className="mt-11">
        <div className="h-7 w-40 animate-pulse rounded bg-line/60" />
      </section>
    );
  }

  return (
    <section className="mt-11 border-t border-line pt-9">
      <h2 className="font-display text-2xl font-semibold">Your notes</h2>

      {/* The standing note. One box, autosaved, rewritten over time. */}
      <textarea
        value={note}
        onChange={(e) => onNoteChange(e.target.value)}
        rows={3}
        placeholder="What you'd change next time — “half the sugar”, “needs 10 more minutes”."
        className="mt-4 w-full resize-y rounded-2xl border border-line bg-surface px-4 py-3 text-base leading-relaxed outline-none transition placeholder:text-muted/70 focus:border-accent"
      />
      <p className="mt-1.5 h-5 text-sm text-muted">
        {noteState === "saving" && "Saving…"}
        {noteState === "saved" && savedNote && "Saved"}
      </p>

      <div className="mt-8 flex items-baseline justify-between gap-4">
        <h2 className="font-display text-2xl font-semibold">Cooking log</h2>
        {cooks.length > 0 && (
          <span className="text-base text-muted">
            {cooks.length === 1 ? "once" : `${cooks.length} times`}
          </span>
        )}
      </div>

      {/* Logging a cook. Collapsed to one button until you want the detail —
          the common case is "I made this" with nothing more to say. */}
      {expanded ? (
        <div className="mt-4 rounded-2xl border border-line bg-surface p-4">
          <p className="text-base font-semibold">How was it?</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {COOK_RATINGS.map((r) => {
              const on = rating === r;
              return (
                <button
                  key={r}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setRating(on ? null : r)}
                  className={`rounded-full border px-4 py-2.5 text-base transition ${
                    on
                      ? "border-accent bg-accent font-semibold text-white"
                      : "border-line bg-surface active:bg-accent-soft"
                  }`}
                >
                  {RATING_LABELS[r]}
                  <span
                    className={`ml-2 text-sm ${on ? "text-white/75" : "text-muted"}`}
                  >
                    {RATING_HINTS[r]}
                  </span>
                </button>
              );
            })}
          </div>

          <textarea
            value={cookNote}
            onChange={(e) => setCookNote(e.target.value)}
            rows={2}
            placeholder="How it went this time (optional)"
            className="mt-3 w-full resize-y rounded-xl border border-line bg-paper px-3.5 py-2.5 text-base outline-none transition placeholder:text-muted/70 focus:border-accent"
          />

          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={logCook}
              disabled={logging}
              className="h-12 flex-1 rounded-xl bg-accent px-5 text-base font-semibold text-white transition active:opacity-90 disabled:opacity-40"
            >
              {logging ? "Saving…" : "Log it"}
            </button>
            <button
              type="button"
              onClick={() => setExpanded(false)}
              className="h-12 rounded-xl px-5 text-base text-muted transition active:opacity-60"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-4 h-13 w-full rounded-2xl border border-accent bg-accent-soft px-5 text-base font-semibold text-accent transition active:opacity-80"
        >
          I cooked this
        </button>
      )}

      {cooks.length > 0 && (
        <ul className="mt-6 space-y-3">
          {cooks.map((cook) => (
            <li
              key={cook.id}
              className="flex items-baseline gap-3 border-b border-line pb-3 last:border-0"
            >
              <span className="text-base text-muted">
                {relativeDate(cook.cooked_at)}
              </span>
              {cook.rating && (
                <span className="rounded-full bg-accent-soft px-2.5 py-0.5 text-sm font-semibold text-accent">
                  {RATING_LABELS[cook.rating]}
                </span>
              )}
              {cook.note && (
                <span className="text-base leading-snug">{cook.note}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
