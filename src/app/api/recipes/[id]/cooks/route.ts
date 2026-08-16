import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { requireUser } from "@/lib/auth";
import { COOK_RATINGS, type CookRating } from "@/lib/cooking";


/**
 * GET  /api/recipes/[id]/cooks   — the log for one recipe, newest first
 * POST /api/recipes/[id]/cooks   — log a cook  { rating?, note?, cooked_at? }
 *
 * The log is append-only. Editing a past cook would rewrite what happened;
 * a standing instruction belongs in recipe_notes instead.
 */
export async function GET(
  _req: NextRequest,
  ctx: RouteContext<"/api/recipes/[id]/cooks">
) {
  const auth = await requireUser();
  if ("response" in auth) return auth.response;
  const userId = auth.user.id;

  const { id } = await ctx.params;

  const { data, error } = await supabase
    .from("cooks")
    .select("id, recipe_id, cooked_at, rating, note, created_at")
    .eq("user_id", userId)
    .eq("recipe_id", id)
    .order("cooked_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ cooks: data ?? [] });
}

export async function POST(
  req: NextRequest,
  ctx: RouteContext<"/api/recipes/[id]/cooks">
) {
  const auth = await requireUser();
  if ("response" in auth) return auth.response;
  const userId = auth.user.id;

  const { id } = await ctx.params;

  let body: { rating?: unknown; note?: unknown; cooked_at?: unknown };
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const rating = COOK_RATINGS.includes(body.rating as CookRating)
    ? (body.rating as CookRating)
    : null;
  const note =
    typeof body.note === "string" && body.note.trim() ? body.note.trim() : null;
  // Lets you log something you cooked yesterday without lying about when.
  const cookedAt =
    typeof body.cooked_at === "string" && !Number.isNaN(Date.parse(body.cooked_at))
      ? new Date(body.cooked_at).toISOString()
      : new Date().toISOString();

  const { data: cook, error } = await supabase
    .from("cooks")
    .insert({
      user_id: userId,
      recipe_id: id,
      rating,
      note,
      cooked_at: cookedAt,
    })
    .select("id, recipe_id, cooked_at, rating, note, created_at")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Recompute the rollups from the log rather than incrementing. An increment
  // drifts the moment a cook is deleted; recounting is one cheap query and is
  // always right.
  await refreshRollups(id, userId);

  return NextResponse.json({ cook }, { status: 201 });
}

/**
 * Recomputes cook_count and last_cooked_at from the log.
 *
 * NOTE for the multi-user migration: these two columns live on `recipes`,
 * which is shared content — the same category error as `saved`. With two
 * users they overwrite each other's cook counts. They belong on a per-user
 * row alongside saved_recipes in step 2.
 */
async function refreshRollups(recipeId: string, userId: string) {
  const { data } = await supabase
    .from("cooks")
    .select("cooked_at")
    .eq("user_id", userId)
    .eq("recipe_id", recipeId)
    .order("cooked_at", { ascending: false });

  const rows = data ?? [];
  await supabase
    .from("recipes")
    .update({
      cook_count: rows.length,
      last_cooked_at: rows[0]?.cooked_at ?? null,
    })
    .eq("id", recipeId);
}
