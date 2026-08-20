import { SaveButton } from "@/components/save-button";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Recipe } from "@/lib/types";
import { formatMinutes } from "@/lib/format";
import { formatProtein, formatCalories } from "@/lib/nutrition";
import { RecipeImage } from "@/components/recipe-image";

/**
 * One card, used by both the library grid and the discover feed.
 *
 * Every meta element is conditional — a recipe with no time and no nutrition
 * renders a title and nothing else, rather than "— min · 0g".
 */
export function RecipeCard({
  recipe,
  eager = false,
  showSave = false,
  onSavedChange,
  showLibraryActions = false,
  onRemoved,
  dense = false,
}: {
  recipe: Recipe;
  eager?: boolean;
  /** Discover shows it; the library doesn't need it on every tile. */
  showSave?: boolean;
  onSavedChange?: (saved: boolean) => void;
  /** Library: un-save without opening the recipe, and jump into cook mode. */
  showLibraryActions?: boolean;
  onRemoved?: (id: string) => void;
  /** Scanning mode: square crop, compact type, two per row. */
  dense?: boolean;
}) {
  const time = formatMinutes(recipe.total_minutes);
  const protein = formatProtein(recipe.protein_grams, recipe.protein_source);
  const calories = formatCalories(recipe.calories);
  const meta = [time, protein, calories].filter(Boolean);

  if (dense) {
    // No card container, no shadow, no ring — the photo IS the card. Dropping
    // the chrome is what lets six recipes share a screen that used to show one.
    return (
      <Link
        href={`/recipe/${recipe.id}`}
        className="group block focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <div className="relative overflow-hidden rounded-[var(--radius-card)] bg-surface">
          <RecipeImage
            optimise={false}
            src={recipe.image_url}
            title={recipe.title}
            generated={recipe.extraction_method === "llm_generated"}
            eager={eager}
            sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw"
            className="aspect-[4/5]"
          />
          {showSave && (
            <SaveButton
              recipeId={recipe.id}
              initialSaved={recipe.saved}
              onChange={onSavedChange}
              size="dense"
            />
          )}
          {showLibraryActions && (
            <LibraryActions recipe={recipe} onRemoved={onRemoved} dense />
          )}
        </div>
        {/* Fixed height, not intrinsic. line-clamp-2 CAPS at two lines but
            doesn't RESERVE them, so a one-line title made a tile 19px shorter
            than a two-line one — rows never aligned, and no fixed-size skeleton
            could match a variable card. 60px = two lines at 15px/1.25 (38) +
            mt-0.5 (2) + one 13px line (20).

            Reserving the space is not the same as rendering placeholder text:
            a recipe with no time still shows nothing, it just doesn't drag the
            tile up. */}
        <div className="mt-2 h-[60px]">
          <h2 className="line-clamp-2 font-display text-[15px] leading-[1.25] font-semibold text-balance">
            {recipe.title}
          </h2>
          {time && (
            <p className="figures-text mt-0.5 text-[13px] text-muted">{time}</p>
          )}
        </div>
      </Link>
    );
  }

  return (
    <Link
      href={`/recipe/${recipe.id}`}
      className="group block overflow-hidden rounded-[var(--radius-card)] bg-surface shadow-sm ring-1 ring-line transition duration-200 hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent active:translate-y-0"
    >
      <div className="relative">
        <RecipeImage
          optimise={false}
          src={recipe.image_url}
          title={recipe.title}
          generated={recipe.extraction_method === "llm_generated"}
          eager={eager}
          className="aspect-[16/10]"
          imgClassName="transition-transform duration-300 group-hover:scale-[1.03]"
        />
        {showSave && (
          <SaveButton
            recipeId={recipe.id}
            initialSaved={recipe.saved}
            onChange={onSavedChange}
          />
        )}
        {showLibraryActions && (
          <LibraryActions recipe={recipe} onRemoved={onRemoved} />
        )}
      </div>

      <div className="px-5 py-4">
        <h2 className="font-display text-xl leading-snug font-semibold text-balance">
          {recipe.title}
        </h2>
        {meta.length > 0 && (
          <p className="mt-2 text-base text-muted">{meta.join(" · ")}</p>
        )}
      </div>
    </Link>
  );
}

/**
 * Cook and remove, on the tile itself.
 *
 * Both were previously only reachable by opening the recipe, which is a lot of
 * taps for "I've made this before, start it" — the single most likely thing
 * you want from a library card.
 */
function LibraryActions({
  recipe,
  onRemoved,
  dense = false,
}: {
  recipe: Recipe;
  onRemoved?: (id: string) => void;
  /** Scanning mode: smaller targets so they don't cover a square thumbnail. */
  dense?: boolean;
}) {
  const router = useRouter();
  const size = dense ? "h-8 w-8" : "h-11 w-11";
  return (
    <div
      className={`absolute flex gap-1 ${dense ? "top-1.5 right-1.5" : "top-3 right-3"}`}
    >
      {/* A <button> that navigates, not a <Link>. The whole card is already
          an <a>, and an anchor inside an anchor is invalid HTML — React threw
          a hydration error on every library render because of it. */}
      <button
        type="button"
        aria-label={`Cook ${recipe.title}`}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          router.push(`/recipe/${recipe.id}?cook=1`);
        }}
        className={`flex ${size} items-center justify-center rounded-full bg-black/35 text-white backdrop-blur-sm transition active:scale-90`}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
          <path d="M8 5v14l11-7z" strokeLinejoin="round" />
        </svg>
      </button>
      <button
        type="button"
        aria-label={`Remove ${recipe.title} from library`}
        onClick={async (e) => {
          e.preventDefault();
          e.stopPropagation();
          // Non-destructive: returns the recipe to the corpus and clears the
          // swipe so it can be rediscovered.
          const res = await fetch(`/api/recipes/${recipe.id}`, { method: "DELETE" });
          if (res.ok) onRemoved?.(recipe.id);
        }}
        className={`flex ${size} items-center justify-center rounded-full bg-black/35 text-white backdrop-blur-sm transition active:scale-90`}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
          <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
