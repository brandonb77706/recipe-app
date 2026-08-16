import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { requireUser } from "@/lib/auth";


/**
 * The standing note for a recipe — "use half the sugar", "needs 10 more
 * minutes than it says". One per recipe, rewritten as you learn the dish.
 *
 * Deliberately separate from the cook log: a note attached to the last cook
 * would vanish the next time you logged one without repeating it.
 *
 * GET    /api/recipes/[id]/note
 * PUT    /api/recipes/[id]/note   { note }   — empty string deletes
 * DELETE /api/recipes/[id]/note
 */
export async function GET(
  _req: NextRequest,
  ctx: RouteContext<"/api/recipes/[id]/note">
) {
  const auth = await requireUser();
  if ("response" in auth) return auth.response;
  const userId = auth.user.id;

  const { id } = await ctx.params;

  const { data, error } = await supabase
    .from("recipe_notes")
    .select("recipe_id, note, updated_at")
    .eq("user_id", userId)
    .eq("recipe_id", id)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  // No row is the normal empty state, not an error.
  return NextResponse.json({ note: data ?? null });
}

export async function PUT(
  req: NextRequest,
  ctx: RouteContext<"/api/recipes/[id]/note">
) {
  const auth = await requireUser();
  if ("response" in auth) return auth.response;
  const userId = auth.user.id;

  const { id } = await ctx.params;

  let body: { note?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const text = typeof body.note === "string" ? body.note.trim() : "";

  // Clearing the box means deleting the note, not storing an empty one — an
  // empty row would render as a note that exists and says nothing.
  if (!text) {
    const { error } = await supabase
      .from("recipe_notes")
      .delete()
      .eq("user_id", userId)
      .eq("recipe_id", id);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ note: null });
  }

  const { data, error } = await supabase
    .from("recipe_notes")
    .upsert(
      {
        user_id: userId,
        recipe_id: id,
        note: text,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,recipe_id" }
    )
    .select("recipe_id, note, updated_at")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ note: data });
}

export async function DELETE(
  _req: NextRequest,
  ctx: RouteContext<"/api/recipes/[id]/note">
) {
  const auth = await requireUser();
  if ("response" in auth) return auth.response;
  const userId = auth.user.id;

  const { id } = await ctx.params;

  const { error } = await supabase
    .from("recipe_notes")
    .delete()
    .eq("user_id", userId)
    .eq("recipe_id", id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ note: null });
}
