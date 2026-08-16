import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { requireUser } from "@/lib/auth";

import { RECIPE_COLUMNS } from "@/lib/types";

// Postgres throws on a non-UUID `id`, which would surface as a 500 with a
// driver error in the body. A bad id is just a miss.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const notFound = () =>
  NextResponse.json({ error: "recipe not found" }, { status: 404 });

export async function GET(
  _req: Request,
  ctx: RouteContext<"/api/recipes/[id]">
) {
  const auth = await requireUser();
  if ("response" in auth) return auth.response;

  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return notFound();

  const { data, error } = await supabase
    .from("recipes")
    .select(RECIPE_COLUMNS)
    .eq("id", id)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) return notFound();

  return NextResponse.json({ recipe: data });
}

/**
 * DELETE /api/recipes/[id] — remove from the library.
 *
 * Non-destructive by default, and that default matters: a crawled row that is
 * hard-deleted is gone for good, because crawl_attempts has its URL recorded
 * as `stored` and the next crawl will skip it rather than re-fetch. Getting it
 * back would need --retry-failed on the whole domain.
 *
 * So a corpus recipe returns to the corpus, and the swipe row goes with it.
 * Flipping `saved` alone would leave the swipe behind, and passesHardFilters
 * would keep the recipe permanently invisible to Discover with no way back —
 * removed from the library AND unreachable, which is the worst of both.
 *
 * ?purge=true hard-deletes. Only meaningful for hand-imported recipes, which
 * have no corpus to return to.
 */
export async function DELETE(
  req: Request,
  ctx: RouteContext<"/api/recipes/[id]">
) {
  const auth = await requireUser();
  if ("response" in auth) return auth.response;
  const userId = auth.user.id;

  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return notFound();

  const purge = new URL(req.url).searchParams.get("purge") === "true";

  const { data: recipe, error: readError } = await supabase
    .from("recipes")
    .select("id, source_url, saved")
    .eq("id", id)
    .maybeSingle();

  if (readError) {
    return NextResponse.json({ error: readError.message }, { status: 500 });
  }
  if (!recipe) return notFound();

  // The swipe goes either way — it's what makes the recipe visible again.
  const { error: swipeError } = await supabase
    .from("swipes")
    .delete()
    .eq("user_id", userId)
    .eq("recipe_id", id);

  if (swipeError) {
    return NextResponse.json({ error: swipeError.message }, { status: 500 });
  }

  if (purge) {
    const { error } = await supabase.from("recipes").delete().eq("id", id);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true, purged: true });
  }

  const { error } = await supabase
    .from("recipes")
    .update({ saved: false, user_id: null, saved_at: null })
    .eq("id", id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, purged: false });
}
