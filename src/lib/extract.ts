/* eslint-disable @typescript-eslint/no-explicit-any -- JSON-LD and LLM output
   are arbitrary untyped JSON from third parties. Narrowing every access to
   `unknown` here would mean rewriting the parsers, and this file's contract is
   that its behavior is byte-identical to the original import route. */

// The one and only copy of the extraction pipeline. Both /api/import and
// scripts/seed.ts import from here — do not duplicate any of this logic.
import Anthropic from "@anthropic-ai/sdk";
import * as cheerio from "cheerio";
import { decodeHTML } from "entities";
import type { Ingredient } from "./types";

// Constructed on first use, not at module load — the seed script imports this
// file with the LLM path disabled and shouldn't need an API key present.
let anthropicClient: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
  }
  return anthropicClient;
}

/** The shape extraction produces, before it becomes a database row. */
export type ExtractedRecipe = {
  title: string;
  image_url: string | null;
  author: string | null;
  total_minutes: number | null;
  servings: number | null;
  ingredients: Ingredient[];
  steps: string[];
  tags: string[];
};

export type ExtractResult =
  | {
      recipe: ExtractedRecipe;
      method: string;
      html: string;
      /** Raw JSON-LD Recipe node, capped. Null on the LLM path. */
      jsonld: any | null;
    }
  | { error: string };

// Anything thrown away at ingest costs a full re-crawl to recover, so the
// whole Recipe node is kept — keywords, aggregateRating, prepTime/cookTime,
// video and nutrition all become useful later. Some sites embed enormous
// nested objects though, so oversized nodes are reduced to the fields we
// know we want.
const MAX_JSONLD_BYTES = 50_000;

export function capJsonLd(node: any): any | null {
  if (!node || typeof node !== "object") return null;

  let serialized: string;
  try {
    serialized = JSON.stringify(node);
  } catch {
    return null; // circular or otherwise unserializable
  }

  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes <= MAX_JSONLD_BYTES) return node;

  return {
    nutrition: node.nutrition ?? null,
    keywords: node.keywords ?? null,
    recipeCategory: node.recipeCategory ?? null,
    aggregateRating: node.aggregateRating ?? null,
    prepTime: node.prepTime ?? null,
    cookTime: node.cookTime ?? null,
    totalTime: node.totalTime ?? null,
    _truncated: true,
    _original_bytes: bytes,
  };
}

// ---------------------------------------------------------------------------
// URL normalization — strip tracking junk so dedupe actually works.
// ---------------------------------------------------------------------------

const TRACKING_PARAMS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "fbclid",
  "gclid",
  "igshid",
  "ref",
  "ref_src",
  "_branch_match_id",
];

/** "https://www.budgetbytes.com/x" -> "budgetbytes.com". One copy, shared
 *  with the seed script so corpus and hand-imported rows agree. */
export function sourceDomain(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

export function normalizeUrl(input: string): string {
  const u = new URL(input.trim());
  TRACKING_PARAMS.forEach((p) => u.searchParams.delete(p));
  u.hash = "";
  let s = u.toString();
  if (s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

// ---------------------------------------------------------------------------
// Ingredient parsing — turn "1 1/2 cups all-purpose flour" into structured data
// so serving-size scaling works later without re-parsing strings.
// ---------------------------------------------------------------------------

const UNICODE_FRACTIONS: Record<string, number> = {
  "½": 0.5,
  "⅓": 0.333,
  "⅔": 0.667,
  "¼": 0.25,
  "¾": 0.75,
  "⅕": 0.2,
  "⅖": 0.4,
  "⅗": 0.6,
  "⅘": 0.8,
  "⅙": 0.167,
  "⅚": 0.833,
  "⅛": 0.125,
  "⅜": 0.375,
  "⅝": 0.625,
  "⅞": 0.875,
};

const UNITS = [
  "cups",
  "cup",
  "tablespoons",
  "tablespoon",
  "tbsp",
  "teaspoons",
  "teaspoon",
  "tsp",
  "ounces",
  "ounce",
  "oz",
  "pounds",
  "pound",
  "lbs",
  "lb",
  "grams",
  "gram",
  "g",
  "kilograms",
  "kilogram",
  "kg",
  "milliliters",
  "milliliter",
  "ml",
  "liters",
  "liter",
  "l",
  "cloves",
  "clove",
  "pinch",
  "pinches",
  "cans",
  "can",
  "packages",
  "package",
  "slices",
  "slice",
  "sprigs",
  "sprig",
];

export function parseIngredient(raw: string): Ingredient {
  const cleaned = raw
    .trim()
    .replace(/\s*\(\s*\$[\d.,]+\s*\)\s*$/, "") // trailing ($0.37)
    .replace(/\s+/g, " ");
  let rest = cleaned;
  let quantity: number | null = null;

  // Leading quantity: "2", "1.5", "1/2", "1 1/2", "½", "1½", "2-3"
  const qtyMatch = rest.match(
    /^(\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:\.\d+)?(?:\s*[-–]\s*\d+(?:\.\d+)?)?|[½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞])\s*/
  );

  if (qtyMatch) {
    const q = qtyMatch[1].trim();
    if (UNICODE_FRACTIONS[q] !== undefined) {
      quantity = UNICODE_FRACTIONS[q];
    } else if (q.includes("/")) {
      const parts = q.split(/\s+/);
      quantity = parts.reduce((sum, part) => {
        if (part.includes("/")) {
          const [n, d] = part.split("/").map(Number);
          return sum + (d ? n / d : 0);
        }
        return sum + Number(part);
      }, 0);
    } else if (/[-–]/.test(q)) {
      // Range like "2-3" — take the lower bound.
      quantity = Number(q.split(/[-–]/)[0].trim());
    } else {
      quantity = Number(q);
    }
    rest = rest.slice(qtyMatch[0].length);
  }

  // Unit immediately after the quantity
  let unit: string | null = null;
  const unitMatch = rest.match(
    new RegExp(`^(${UNITS.join("|")})\\b\\.?\\s*`, "i")
  );
  if (unitMatch) {
    unit = unitMatch[1].toLowerCase();
    rest = rest.slice(unitMatch[0].length);
  }

  return {
    quantity: quantity !== null && !isNaN(quantity) ? quantity : null,
    unit,
    name: rest.trim() || cleaned,
    raw: cleaned,
  };
}

/** ISO 8601 duration ("PT1H30M") -> minutes */
export function parseDuration(d: unknown): number | null {
  if (typeof d !== "string") return null;
  const m = d.match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/);
  if (!m) return null;
  const mins = +(m[1] || 0) * 1440 + +(m[2] || 0) * 60 + +(m[3] || 0);
  return mins > 0 ? mins : null;
}

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

// Plenty of sites HTML-escape their JSON-LD payload, so "&#32;", "&amp;" and
// "&nbsp;" survive JSON.parse and end up in stored text. Decode once here, at
// ingest — never at display time. Collapsing whitespace afterwards folds a
// decoded &nbsp; (U+00A0) into an ordinary space.
export function decodeText(value: unknown): string {
  if (value == null) return "";
  // Strip tags before decoding entities, not after: some sites embed hRecipe
  // markup inside the JSON-LD name ('<span class="fn">Pumpkin Bundt Cake'),
  // while an author who wrote "&lt;b&gt;" meant those angle brackets
  // literally and should keep them.
  const withoutTags = String(value).replace(/<[^>]*>/g, " ");
  return decodeHTML(withoutTags).replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Fetching — the UA matters, plenty of sites 403 anything that looks scripted.
// ---------------------------------------------------------------------------

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/122.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml",
};

/** Resolves to the page HTML, or an `{ error }` in the same wording the
 *  import route has always returned. */
export async function fetchPage(
  url: string,
  timeoutMs = 15000
): Promise<{ html: string } | { error: string }> {
  try {
    const res = await fetch(url, {
      headers: BROWSER_HEADERS,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { error: `fetch failed: ${res.status}` };
    return { html: await res.text() };
  } catch (e: any) {
    return { error: `fetch error: ${e.message}` };
  }
}

/**
 * Splits "1. Do this. 2. Do that." into separate steps.
 *
 * Only splits when the markers run 1, 2, 3… in order, so a sentence like
 * "preheat to 350. 2 cups flour" can't fool it. Returns null when the text
 * isn't a numbered list.
 */
function splitNumbered(text: string): string[] | null {
  // Markers may follow whitespace ("... skillet. 2. Add") or run straight on
  // from the previous sentence ("... to 425°F.2. Season"), which is what Half
  // Baked Harvest emits.
  const parts = text.split(/(?:\s+|(?<=[.!?)]))(?=\d{1,2}\.\s)/);
  if (parts.length < 2) return null;

  for (let i = 0; i < parts.length; i++) {
    if (!new RegExp(`^${i + 1}\\.\\s`).test(parts[i].trim())) return null;
  }

  return parts
    .map((p) => p.trim().replace(/^\d{1,2}\.\s*/, "").trim())
    .filter(Boolean);
}

/**
 * Some sites (Half Baked Harvest among them) put every instruction inside a
 * single HowToStep. Stored as-is that's one wall of text, which defeats
 * cook mode entirely.
 */
export function splitInstructionBlob(raw: string): string[] {
  const withBreaks = raw
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|li|div|h[1-6])>/gi, "\n")
    .replace(/<[^>]*>/g, " ");

  // Decode before splitting, not after. Sites separate steps with a literal
  // "&nbsp;", and a decoded U+00A0 is matched by \s where the entity text is
  // not — leaving one marker unsplit breaks the 1,2,3 sequence and loses the
  // whole recipe. Returns finished strings, so callers must not decode again.
  const text = decodeHTML(withBreaks);
  const tidy = (s: string) => s.replace(/\s+/g, " ").trim();

  const numbered = splitNumbered(text);
  if (numbered && numbered.length >= 2)
    return numbered.map(tidy).filter(Boolean);

  const lines = text.split(/\n+/).map(tidy).filter(Boolean);
  if (lines.length >= 2) return lines;

  return [tidy(text)].filter(Boolean);
}

// ---------------------------------------------------------------------------
// Path 1: JSON-LD. Free, instant, works on most recipe blogs because Google
// requires this markup for rich results.
// ---------------------------------------------------------------------------

export function findRecipeNode(node: any): any | null {
  if (!node || typeof node !== "object") return null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findRecipeNode(item);
      if (found) return found;
    }
    return null;
  }

  const types = asArray(node["@type"]);
  if (types.some((t: any) => String(t).toLowerCase() === "recipe")) return node;

  // Recipes are often nested inside an @graph array
  if (node["@graph"]) return findRecipeNode(node["@graph"]);

  return null;
}

/** Returns the parsed recipe alongside the raw Recipe node it came from, so
 *  callers can persist the untouched JSON-LD. */
export function extractJsonLd(
  $: cheerio.CheerioAPI
): { recipe: ExtractedRecipe; node: any } | null {
  const scripts = $('script[type="application/ld+json"]').toArray();

  for (const el of scripts) {
    const text = $(el).contents().text();
    if (!text.trim()) continue;

    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue; // some sites ship malformed JSON-LD; just move on
    }

    const r = findRecipeNode(parsed);
    if (!r) continue;

    const ingredientStrings = asArray(r.recipeIngredient)
      .map((i: any) => decodeText(i))
      .filter(Boolean);

    // recipeInstructions comes in ~4 different shapes depending on the site.
    // Collect raw first so a single-blob payload can still be split — decoding
    // collapses the newlines that splitting depends on.
    const rawSteps: string[] = [];
    const walkInstructions = (ins: any) => {
      for (const step of asArray(ins)) {
        if (typeof step === "string") {
          rawSteps.push(step);
        } else if (step?.["@type"] === "HowToSection") {
          walkInstructions(step.itemListElement);
        } else if (step?.text) {
          rawSteps.push(String(step.text));
        }
      }
    };
    walkInstructions(r.recipeInstructions);

    // splitInstructionBlob returns already-decoded text; decoding twice would
    // turn a deliberate "&amp;amp;" into a bare ampersand.
    const steps = (
      rawSteps.length === 1
        ? splitInstructionBlob(rawSteps[0])
        : rawSteps.map(decodeText)
    ).filter(Boolean);

    if (!ingredientStrings.length || !steps.length) continue;

    let image: string | null = null;
    const img = r.image;
    if (typeof img === "string") image = img;
    else if (Array.isArray(img))
      image = typeof img[0] === "string" ? img[0] : img[0]?.url ?? null;
    else if (img?.url) image = img.url;

    const yieldRaw = asArray(r.recipeYield)[0];
    const servings = yieldRaw
      ? parseInt(String(yieldRaw).match(/\d+/)?.[0] ?? "", 10)
      : NaN;

    const authorName = asArray(r.author)[0]?.name;

    return {
      recipe: {
        title: decodeText(r.name) || "Untitled",
        image_url: image,
        author: authorName ? decodeText(authorName) || null : null,
        total_minutes: parseDuration(r.totalTime) ?? parseDuration(r.cookTime),
        servings: isNaN(servings) ? null : servings,
        ingredients: ingredientStrings.map(parseIngredient),
        steps: steps.filter(Boolean),
        tags: [
          ...asArray(r.recipeCuisine).map(decodeText),
          ...asArray(r.recipeCategory).map(decodeText),
        ].filter(Boolean),
      },
      node: r,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Path 2: LLM fallback. Only runs when there's no JSON-LD. Haiku is plenty —
// this is reformatting, not reasoning.
// ---------------------------------------------------------------------------

const EXTRACTION_PROMPT = `You extract recipes from web page text into JSON.

Output ONLY a JSON object, no prose, no markdown fences. Shape:
{
  "title": string,
  "author": string | null,
  "total_minutes": number | null,
  "servings": number | null,
  "ingredients": [{"quantity": number|null, "unit": string|null, "name": string, "raw": string}],
  "steps": [string],
  "tags": [string]
}

Rules:
- "raw" is the ingredient exactly as written on the page.
- Convert fractions to decimals in "quantity" (1/2 -> 0.5). Use null if there is no number.
- "unit" is null for countable items (2 eggs -> quantity 2, unit null, name "eggs").
- "steps" are the instructions in order, one per array element. Strip step numbers.
- tags: cuisine, meal type, or diet if evident. Empty array if unclear.
- If the page contains no actual recipe, return {"title": "NOT_A_RECIPE"}.`;

export function htmlToText($: cheerio.CheerioAPI): string {
  $("script, style, nav, footer, header, noscript, svg, iframe").remove();
  return $("body").text().replace(/\s+/g, " ").trim().slice(0, 15000); // cap tokens; recipes live near the top of the page
}

export async function extractWithLlm(
  text: string,
  sourceUrl: string
): Promise<ExtractedRecipe | null> {
  const msg = await anthropic().messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 2000,
    system: EXTRACTION_PROMPT,
    messages: [
      { role: "user", content: `Source: ${sourceUrl}\n\nPage text:\n${text}` },
      { role: "assistant", content: "{" }, // prefill forces valid JSON, no fences
    ],
  });

  const block = msg.content.find((c) => c.type === "text");
  if (!block || block.type !== "text") return null;

  let parsed: any;
  try {
    parsed = JSON.parse("{" + block.text);
  } catch {
    return null;
  }

  if (!parsed.title || parsed.title === "NOT_A_RECIPE") return null;
  if (!parsed.ingredients?.length || !parsed.steps?.length) return null;

  return {
    title: parsed.title,
    image_url: null, // filled from og:image by the caller
    author: parsed.author ?? null,
    total_minutes: parsed.total_minutes ?? null,
    servings: parsed.servings ?? null,
    ingredients: parsed.ingredients.map((i: any) => ({
      quantity: typeof i.quantity === "number" ? i.quantity : null,
      unit: i.unit ?? null,
      name: String(i.name ?? ""),
      raw: String(i.raw ?? i.name ?? ""),
    })),
    steps: parsed.steps.map(String),
    tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : [],
  };
}

// ---------------------------------------------------------------------------
// Orchestrator — fetch, then cascade free path before paid path.
// ---------------------------------------------------------------------------

export async function extractRecipe(
  url: string,
  opts: { allowLlmFallback?: boolean } = {}
): Promise<ExtractResult> {
  // The crawler passes false: firing Haiku at thousands of sitemap URLs to
  // salvage pages that mostly aren't recipes is exactly the wrong trade.
  const { allowLlmFallback = true } = opts;

  const fetched = await fetchPage(url);
  if ("error" in fetched) return { error: fetched.error };

  const $ = cheerio.load(fetched.html);

  const fromJsonLd = extractJsonLd($);
  let recipe = fromJsonLd?.recipe ?? null;
  let jsonld: any | null = fromJsonLd ? capJsonLd(fromJsonLd.node) : null;
  let method = "jsonld";

  if (!recipe && allowLlmFallback) {
    method = "llm_html";
    jsonld = null;
    recipe = await extractWithLlm(htmlToText($), url);
  }

  if (!recipe) {
    return { error: allowLlmFallback ? "no recipe found on page" : "no jsonld" };
  }

  // og:image as an image fallback
  if (!recipe.image_url) {
    recipe.image_url = $('meta[property="og:image"]').attr("content") ?? null;
  }

  return { recipe, method, html: fetched.html, jsonld };
}
