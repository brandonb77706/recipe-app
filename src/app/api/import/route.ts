// src/app/api/import/route.ts
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { requireUser } from "@/lib/auth";
import { extractRecipe, normalizeUrl, sourceDomain } from "@/lib/extract";

// Single-user for now. Generate one UUID and keep it forever.
// Later this comes from Supabase Auth instead.

export async function POST(req: NextRequest) {
  const auth = await requireUser();
  if ("response" in auth) return auth.response;
  const userId = auth.user.id;

  // 1. Auth. Without this, anyone who finds the URL can burn your API credits.
  if (req.headers.get("x-import-secret") !== process.env.IMPORT_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let url: string;
  try {
    const body = await req.json();
    url = normalizeUrl(body.url);
  } catch {
    return NextResponse.json({ error: "invalid url" }, { status: 400 });
  }

  // 2. Dedupe. A repeat import costs zero — no fetch, no LLM call.
  const { data: existing } = await supabase
    .from("recipes")
    .select("*")
    .eq("source_url", url)
    .maybeSingle();

  if (existing) {
    return NextResponse.json({ recipe: existing, cached: true });
  }

  // 3. Fetch + extract. Hand imports get the LLM fallback; the crawler doesn't.
  const result = await extractRecipe(url, { allowLlmFallback: true });

  if ("error" in result) {
    // Fetch problems have always been 502, "no recipe" 422. Keep it that way.
    const status = result.error.startsWith("fetch ") ? 502 : 422;
    return NextResponse.json({ error: result.error }, { status });
  }

  const { recipe, method, html, jsonld } = result;

  // 4. Store. raw_payload is cheap insurance — when the prompt improves later,
  // you can re-extract everything without re-fetching a single page.
  const { data, error } = await supabase
    .from("recipes")
    .insert({
      user_id: userId,
      source_url: url,
      // Hand imports are library, not corpus. The column defaults to false
      // for crawled rows, so this has to be explicit.
      saved: true,
      saved_at: new Date().toISOString(),
      source_domain: sourceDomain(url),
      title: recipe.title,
      image_url: recipe.image_url,
      author: recipe.author,
      total_minutes: recipe.total_minutes,
      servings: recipe.servings,
      ingredients: recipe.ingredients,
      steps: recipe.steps,
      tags: recipe.tags,
      extraction_method: method,
      raw_payload: {
        html_length: html.length,
        extracted_at: new Date().toISOString(),
        // Keeping the whole node means later enrichment passes never need a
        // re-crawl to recover a field we didn't think to extract.
        jsonld,
      },
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ recipe: data, cached: false, method });
}
