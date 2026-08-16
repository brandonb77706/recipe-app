import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { requireUser } from "@/lib/auth";


/** The table has a check constraint on this; keep the two in step. */
const DIRECTIONS = ["left", "right"] as const;
type Direction = (typeof DIRECTIONS)[number];

/**
 * POST /api/swipe   { recipe_id, direction }
 *
 * Right saves the recipe into the library, left is a pass. Both record a row
 * so Discover stops showing it either way — the swipe log is what makes the
 * feed finite, not the save.
 */
export async function POST(req: NextRequest) {
  const auth = await requireUser();
  if ("response" in auth) return auth.response;
  const userId = auth.user.id;

  let body: { recipe_id?: unknown; direction?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const recipeId = typeof body.recipe_id === "string" ? body.recipe_id : null;
  const direction = DIRECTIONS.includes(body.direction as Direction)
    ? (body.direction as Direction)
    : null;

  if (!recipeId || !direction) {
    return NextResponse.json(
      { error: "recipe_id and direction ('left' | 'right') are required" },
      { status: 400 }
    );
  }

  // Upsert, not insert: the table is unique on (user_id, recipe_id), and
  // undo-then-swipe-again is a normal thing to do.
  const { error: swipeError } = await supabase
    .from("swipes")
    .upsert(
      { user_id: userId, recipe_id: recipeId, direction },
      { onConflict: "user_id,recipe_id" }
    );

  if (swipeError) {
    return NextResponse.json({ error: swipeError.message }, { status: 500 });
  }

  if (direction === "right") {
    // Only corpus rows reach the deck, so this is always false -> true.
    // Claiming ownership at the same time is what moves it into the library.
    const { error: saveError } = await supabase
      .from("recipes")
      // saved_at is the moment you kept it. created_at is when the crawler
      // found it, which is meaningless as a "recently added" sort key.
      .update({ saved: true, user_id: userId, saved_at: new Date().toISOString() })
      .eq("id", recipeId)
      .eq("saved", false);

    if (saveError) {
      return NextResponse.json({ error: saveError.message }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: true, recipe_id: recipeId, direction });
}

/**
 * DELETE /api/swipe   { recipe_id }
 *
 * Undo. Removes the swipe and, if it was a save, returns the recipe to the
 * corpus — safe because a recipe already in the library never enters the deck,
 * so a right swipe is the only thing that could have set `saved`.
 */
export async function DELETE(req: NextRequest) {
  const auth = await requireUser();
  if ("response" in auth) return auth.response;
  const userId = auth.user.id;

  let body: { recipe_id?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const recipeId = typeof body.recipe_id === "string" ? body.recipe_id : null;
  if (!recipeId) {
    return NextResponse.json({ error: "recipe_id is required" }, { status: 400 });
  }

  // Read the direction before deleting — it decides whether to un-save.
  const { data: existing, error: readError } = await supabase
    .from("swipes")
    .select("direction")
    .eq("user_id", userId)
    .eq("recipe_id", recipeId)
    .maybeSingle();

  if (readError) {
    return NextResponse.json({ error: readError.message }, { status: 500 });
  }
  if (!existing) {
    // Nothing to undo. Not an error — the client may be retrying.
    return NextResponse.json({ ok: true, undone: false });
  }

  const { error: deleteError } = await supabase
    .from("swipes")
    .delete()
    .eq("user_id", userId)
    .eq("recipe_id", recipeId);

  if (deleteError) {
    return NextResponse.json({ error: deleteError.message }, { status: 500 });
  }

  if (existing.direction === "right") {
    const { error: unsaveError } = await supabase
      .from("recipes")
      .update({ saved: false, user_id: null, saved_at: null })
      .eq("id", recipeId);

    if (unsaveError) {
      return NextResponse.json({ error: unsaveError.message }, { status: 500 });
    }
  }

  return NextResponse.json({
    ok: true,
    undone: true,
    direction: existing.direction,
  });
}

/** GET /api/swipe — counts, for the deck's progress line. */
export async function GET() {
  const auth = await requireUser();
  if ("response" in auth) return auth.response;
  const userId = auth.user.id;

  const { count, error } = await supabase
    .from("swipes")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ total: count ?? 0 });
}
