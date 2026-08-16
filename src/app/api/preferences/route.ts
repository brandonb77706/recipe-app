import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { requireUser } from "@/lib/auth";
import {
  CONCEPT_CHOICES,
  CUISINE_CHOICES,
  DIET_NEEDS,
  MAX_FAVORITE_CUISINES,
  PROTEIN_CHOICES,
} from "@/lib/preferences";


const COLUMNS =
  "user_id, max_minutes, diets, avoid_proteins, strict_proteins, favorite_cuisines, prefer_high_protein, prefer_concepts, completed_at, updated_at";

export async function GET() {
  const auth = await requireUser();
  if ("response" in auth) return auth.response;
  const userId = auth.user.id;

  const { data, error } = await supabase
    .from("preferences")
    .select(COLUMNS)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  // No row at all is the "never onboarded" state — not an error.
  return NextResponse.json({ preferences: data ?? null });
}

/**
 * Accepts a full preference set. Arrays are tri-state: omit a key to leave it
 * untouched, send null for "never answered", send [] for "no preference".
 */
export async function PUT(req: NextRequest) {
  const auth = await requireUser();
  if ("response" in auth) return auth.response;
  const userId = auth.user.id;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const asAnswer = (
    value: unknown,
    allowed: readonly { value: string }[],
    cap?: number
  ): string[] | null | undefined => {
    if (value === undefined) return undefined; // leave alone
    if (value === null) return null; // never answered
    if (!Array.isArray(value)) return undefined;
    const valid = allowed.map((a) => a.value);
    const cleaned = [...new Set(value.filter((v) => valid.includes(v)))];
    return cap ? cleaned.slice(0, cap) : cleaned; // [] means "no preference"
  };

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if ("max_minutes" in body) {
    const m = body.max_minutes;
    patch.max_minutes =
      m === null ? null : Number.isFinite(Number(m)) ? Math.max(1, Number(m)) : null;
  }

  const diets = asAnswer(body.diets, DIET_NEEDS);
  if (diets !== undefined) patch.diets = diets;

  const proteins = asAnswer(body.avoid_proteins, PROTEIN_CHOICES);
  if (proteins !== undefined) {
    patch.avoid_proteins = proteins;
    // Strictness is meaningless for a protein that isn't avoided at all, and a
    // stale entry here would silently hard-exclude on an answer since changed.
    if (proteins === null) patch.strict_proteins = null;
  }

  const strict = asAnswer(body.strict_proteins, PROTEIN_CHOICES);
  if (strict !== undefined) {
    const avoided = proteins ?? null;
    patch.strict_proteins =
      strict === null || avoided === null
        ? strict
        : strict.filter((p) => avoided.includes(p));
  }

  const cuisines = asAnswer(
    body.favorite_cuisines,
    CUISINE_CHOICES,
    MAX_FAVORITE_CUISINES
  );
  if (cuisines !== undefined) patch.favorite_cuisines = cuisines;

  // high_protein is presented with the concepts but stored on its own column.
  const concepts = asAnswer(body.prefer_concepts, CONCEPT_CHOICES);
  if (concepts !== undefined) {
    patch.prefer_high_protein = concepts?.includes("high_protein") ?? false;
    patch.prefer_concepts =
      concepts === null ? null : concepts.filter((c) => c !== "high_protein");
  }

  if (body.completed === true) patch.completed_at = new Date().toISOString();

  const { data, error } = await supabase
    .from("preferences")
    .upsert({ user_id: userId, ...patch }, { onConflict: "user_id" })
    .select(COLUMNS)
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ preferences: data });
}
