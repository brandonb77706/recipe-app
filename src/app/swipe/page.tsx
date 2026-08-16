"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { Recipe } from "@/lib/types";
import { SwipeCard, type SwipeDirection } from "@/components/swipe-card";
import { refreshOfflineCache } from "@/components/offline";

/** Cards fetched per request. */
const BATCH = 20;
/** Refill once the deck gets this thin, so it never runs dry mid-session. */
const REFILL_AT = 6;
/** How many cards are actually mounted. Everything below is invisible anyway. */
const VISIBLE = 3;

type Done = { recipe: Recipe; direction: SwipeDirection };

export default function Swipe() {
  const [deck, setDeck] = useState<Recipe[]>([]);
  const [history, setHistory] = useState<Done[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [refilling, setRefilling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedCount, setSavedCount] = useState(0);

  // Guards a refill from firing on every render while one is already in flight.
  const filling = useRef(false);
  const seen = useRef(new Set<string>());

  /**
   * Swipe writes still in flight.
   *
   * This is load-bearing, not bookkeeping. The server decides what to serve by
   * excluding swiped ids, so a refill that races ahead of those writes gets
   * back the same top-ranked cards it already sent. The client then drops them
   * all as already-seen and keeps only the exploration picks — which are drawn
   * uniformly from the whole tail. The deck silently degenerates into pure
   * random sampling, and the ranking never reaches the screen.
   *
   * Measured before the fix: 165 cards served at a median rank of 1,728 out of
   * 3,469, against an exploration-only expectation of 1,745. Three of them came
   * from the top 50.
   */
  const pending = useRef(new Set<Promise<unknown>>());

  const track = (p: Promise<unknown>) => {
    pending.current.add(p);
    void p.finally(() => pending.current.delete(p));
    return p;
  };

  const fetchBatch = useCallback(async (): Promise<Recipe[]> => {
    // Let every swipe land before asking what to show next.
    if (pending.current.size) {
      await Promise.allSettled([...pending.current]);
    }
    // No offset: the feed already excludes anything swiped, so page 0 is
    // always fresh once the writes above have settled.
    const res = await fetch(`/api/discover?limit=${BATCH}`);
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
    const fresh: Recipe[] = (body.recipes ?? []).filter(
      (r: Recipe) => !seen.current.has(r.id)
    );
    for (const r of fresh) seen.current.add(r.id);
    return fresh;
  }, []);

  /**
   * Refill earlier than strictly necessary. The await above means a refill now
   * costs a round trip for the outstanding writes plus the fetch, so starting
   * it with a card or two still in hand keeps the deck from stalling mid-swipe.
   */

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const batch = await fetchBatch();
        if (cancelled) return;
        setDeck(batch);
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
  }, [fetchBatch]);

  // Warm the next few images so a card never renders as an empty frame.
  useEffect(() => {
    for (const recipe of deck.slice(1, VISIBLE + 2)) {
      if (!recipe.image_url) continue;
      const img = new Image();
      img.src = recipe.image_url;
    }
  }, [deck]);

  const refill = useCallback(async () => {
    if (filling.current) return;
    filling.current = true;
    setRefilling(true);
    try {
      const batch = await fetchBatch();
      setDeck((d) => [...d, ...batch]);
    } catch {
      // A failed refill isn't fatal — the deck keeps working on what it has.
    } finally {
      filling.current = false;
      setRefilling(false);
    }
  }, [fetchBatch]);

  // Emptiness is derived, not stored. A separate "empty" status would need
  // setting from an effect every time the deck drained, and the two could
  // disagree — showing "that's everything" over a deck that just refilled.
  const exhausted = status === "ready" && deck.length === 0 && !refilling;

  const commit = (recipe: Recipe, direction: SwipeDirection) => {
    // Optimistic: the card leaves now and the request settles behind it.
    // A swipe that only moved after a round trip would feel broken.
    setDeck((d) => d.filter((r) => r.id !== recipe.id));
    setHistory((h) => [...h, { recipe, direction }]);
    if (direction === "right") {
      setSavedCount((n) => n + 1);
      // A recipe saved on the bus should be readable in the kitchen.
      refreshOfflineCache();
    }
    // Refill from the swipe itself rather than an effect watching the length:
    // the trigger is the action, and it keeps render free of side effects.
    const write = track(
      fetch("/api/swipe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipe_id: recipe.id, direction }),
      }).catch(() => {
        setError("A swipe didn't save. Check your connection.");
      })
    );
    void write;

    // Ordered after the write is registered, so the refill's await sees it.
    if (deck.length - 1 <= REFILL_AT) void refill();
  };

  const undo = () => {
    const last = history[history.length - 1];
    if (!last) return;

    setHistory((h) => h.slice(0, -1));
    setDeck((d) => [last.recipe, ...d]);
    if (last.direction === "right") setSavedCount((n) => Math.max(0, n - 1));

    // Tracked too: an undo is a write the next refill must not race.
    void track(
      fetch("/api/swipe", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipe_id: last.recipe.id }),
      }).catch(() => {
        setError("Undo didn't reach the server.");
      })
    );
  };

  const top = deck[0];

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-5 pt-[calc(1.5rem+env(safe-area-inset-top))] pb-[calc(1.5rem+env(safe-area-inset-bottom))]">
      <header className="mb-5 flex items-center justify-between">
        <Link
          href="/"
          className="text-base text-muted transition active:opacity-60"
        >
          ← Discover
        </Link>
        <p className="text-base text-muted">
          {savedCount > 0
            ? `${savedCount} saved this session`
            : "Swipe right to save"}
        </p>
      </header>

      <div className="relative min-h-0 flex-1">
        {status === "loading" && (
          <div className="absolute inset-0 animate-pulse rounded-3xl bg-line/50" />
        )}

        {status === "error" && (
          <Message
            title="Couldn’t load the deck"
            body={error ?? "Unknown error"}
          />
        )}

        {exhausted && (
          <Message
            title="That's everything"
            body="You've been through every recipe that matches your preferences. Loosen the time limit in Preferences, or come back after the next crawl."
          />
        )}

        {deck.length > 0 &&
          deck
            .slice(0, VISIBLE)
            .map((recipe, i) => (
              <SwipeCard
                key={recipe.id}
                recipe={recipe}
                depth={i}
                interactive={i === 0}
                onCommit={(direction) => commit(recipe, direction)}
              />
            ))
            // Painter's order: the top card must be last in the DOM so it
            // stacks above the ones behind it.
            .reverse()}
      </div>

      <div className="mt-6 flex items-center justify-center gap-5">
        <RoundButton
          label="Pass"
          onClick={() => top && commit(top, "left")}
          disabled={!top}
        >
          <path d="M6 6l12 12M18 6L6 18" strokeWidth="2.2" />
        </RoundButton>

        <RoundButton
          label="Undo"
          small
          onClick={undo}
          disabled={history.length === 0}
        >
          <path
            d="M9 14L4 9l5-5"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path d="M4 9h9a7 7 0 010 14h-3" strokeWidth="2" strokeLinecap="round" />
        </RoundButton>

        <RoundButton
          label="Save"
          accent
          onClick={() => top && commit(top, "right")}
          disabled={!top}
        >
          <path
            d="M12 20s-7-4.5-7-9.5A3.9 3.9 0 0112 8a3.9 3.9 0 017 2.5c0 5-7 9.5-7 9.5z"
            strokeWidth="2"
            strokeLinejoin="round"
          />
        </RoundButton>
      </div>

      {top && (
        <Link
          href={`/recipe/${top.id}`}
          className="mt-5 text-center text-base text-muted transition active:opacity-60"
        >
          See the full recipe
        </Link>
      )}
    </div>
  );
}

function RoundButton({
  label,
  onClick,
  disabled,
  accent = false,
  small = false,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  accent?: boolean;
  small?: boolean;
  children: React.ReactNode;
}) {
  const size = small ? "h-12 w-12" : "h-16 w-16";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className={`flex ${size} items-center justify-center rounded-full border transition active:scale-95 disabled:opacity-30 ${
        accent
          ? "border-accent bg-accent text-white"
          : "border-line bg-surface text-muted"
      }`}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        className={small ? "h-5 w-5" : "h-7 w-7"}
      >
        {children}
      </svg>
    </button>
  );
}

function Message({ title, body }: { title: string; body: string }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center rounded-3xl border border-dashed border-line px-8 text-center">
      <p className="font-display text-2xl font-semibold">{title}</p>
      <p className="mt-2 max-w-xs text-base text-muted">{body}</p>
    </div>
  );
}
