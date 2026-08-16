"use client";

import { useRef, useState } from "react";
import type { Recipe } from "@/lib/types";
import { formatMinutes } from "@/lib/format";
import { formatProtein, formatCalories } from "@/lib/nutrition";
import { RecipeImage } from "@/components/recipe-image";

/** How far a card must travel before letting go commits the swipe. */
const COMMIT_PX = 110;
/** A fast flick counts even if it didn't travel far. */
const COMMIT_VELOCITY = 0.6; // px per ms

export type SwipeDirection = "left" | "right";

/**
 * One draggable card. Owns only its own drag offset — the deck owns which
 * cards exist, so a committed swipe is a parent state change rather than an
 * animation this component has to coordinate.
 */
export function SwipeCard({
  recipe,
  onCommit,
  interactive,
  depth,
}: {
  recipe: Recipe;
  onCommit: (direction: SwipeDirection) => void;
  /** Only the top card takes input. */
  interactive: boolean;
  /** 0 = top. Used to offset the cards behind it. */
  depth: number;
}) {
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [leaving, setLeaving] = useState<SwipeDirection | null>(null);

  const start = useRef<{ x: number; t: number } | null>(null);

  const commit = (direction: SwipeDirection) => {
    setLeaving(direction);
    // Let the card clear the screen before the deck drops it.
    window.setTimeout(() => onCommit(direction), 180);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!interactive || leaving) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    start.current = { x: e.clientX, t: performance.now() };
    setDragging(true);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!start.current || leaving) return;
    setDx(e.clientX - start.current.x);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (!start.current || leaving) return;
    const travelled = e.clientX - start.current.x;
    const elapsed = Math.max(1, performance.now() - start.current.t);
    const velocity = Math.abs(travelled) / elapsed;

    start.current = null;
    setDragging(false);

    if (Math.abs(travelled) > COMMIT_PX || velocity > COMMIT_VELOCITY) {
      commit(travelled > 0 ? "right" : "left");
    } else {
      setDx(0); // snap back
    }
  };

  const offset = leaving ? (leaving === "right" ? 1000 : -1000) : dx;
  const rotate = offset / 22;
  const intent = Math.min(1, Math.abs(offset) / COMMIT_PX);

  const time = formatMinutes(recipe.total_minutes);
  const protein = formatProtein(recipe.protein_grams, recipe.protein_source);
  const calories = formatCalories(recipe.calories);
  const meta = [time, protein, calories].filter(Boolean);

  return (
    <div
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      style={{
        transform: `translate3d(${offset}px, ${depth * 10}px, 0) rotate(${rotate}deg) scale(${1 - depth * 0.04})`,
        transition: dragging ? "none" : "transform 180ms ease-out",
        zIndex: 10 - depth,
        // Vertical panning stays with the browser; horizontal is ours.
        touchAction: "pan-y",
      }}
      className={`absolute inset-0 overflow-hidden rounded-3xl bg-surface shadow-lg ring-1 ring-line select-none ${
        interactive ? "cursor-grab active:cursor-grabbing" : "pointer-events-none"
      }`}
    >
      <RecipeImage
        optimise={false}
        src={recipe.image_url}
        title={recipe.title}
        generated={recipe.extraction_method === "llm_generated"}
        eager={depth === 0}
        className="h-[62%] w-full"
        imgClassName="pointer-events-none"
      />

      <div className="px-6 py-5">
        <h2 className="font-display text-2xl leading-snug font-semibold text-balance">
          {recipe.title}
        </h2>
        {meta.length > 0 && (
          <p className="mt-2 text-base text-muted">{meta.join(" · ")}</p>
        )}
        {recipe.source_domain && (
          <p className="mt-1 text-sm text-muted">{recipe.source_domain}</p>
        )}
      </div>

      {/* Intent overlays. They track the drag rather than appearing on commit,
          so you can see what letting go will do before you let go. */}
      <Stamp label="Save" side="left" active={offset > 0} strength={intent} />
      <Stamp label="Pass" side="right" active={offset < 0} strength={intent} />
    </div>
  );
}

function Stamp({
  label,
  side,
  active,
  strength,
}: {
  label: string;
  side: "left" | "right";
  active: boolean;
  strength: number;
}) {
  return (
    <span
      aria-hidden
      style={{ opacity: active ? strength : 0 }}
      className={`absolute top-7 ${
        side === "left" ? "left-6 -rotate-12" : "right-6 rotate-12"
      } rounded-xl border-[3px] px-4 py-1.5 font-display text-xl font-bold tracking-wide transition-opacity ${
        label === "Save"
          ? "border-accent bg-accent/90 text-white"
          : "border-ink/70 bg-ink/70 text-paper"
      }`}
    >
      {label}
    </span>
  );
}
