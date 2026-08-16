import { NextRequest, NextResponse } from "next/server";

/**
 * Thin proxy so the browser never sees IMPORT_SECRET. The client posts a URL
 * here; this attaches the secret server-side and forwards to /api/import.
 */
export async function POST(req: NextRequest) {
  let url: string;
  try {
    const body = await req.json();
    url = String(body?.url ?? "").trim();
  } catch {
    return NextResponse.json({ error: "Enter a recipe URL." }, { status: 400 });
  }

  if (!url) {
    return NextResponse.json({ error: "Enter a recipe URL." }, { status: 400 });
  }

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("bad protocol");
    }
  } catch {
    return NextResponse.json(
      { error: "That doesn’t look like a valid link. Paste the full URL." },
      { status: 400 }
    );
  }

  if (!process.env.IMPORT_SECRET) {
    return NextResponse.json(
      { error: "Import isn’t configured — IMPORT_SECRET is missing." },
      { status: 500 }
    );
  }

  let res: Response;
  try {
    res = await fetch(new URL("/api/import", req.nextUrl.origin), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-import-secret": process.env.IMPORT_SECRET,
      },
      body: JSON.stringify({ url }),
    });
  } catch {
    return NextResponse.json(
      { error: "Couldn’t reach the import service." },
      { status: 502 }
    );
  }

  const body = await res.json().catch(() => null);

  if (!res.ok) {
    return NextResponse.json(
      { error: explain(res.status, body?.error) },
      { status: res.status }
    );
  }

  return NextResponse.json(body);
}

/**
 * Turn the import route's terse errors into something readable. A blocked
 * fetch has to say the site blocked us, not fail vaguely.
 */
function explain(status: number, raw?: string): string {
  const message = String(raw ?? "");

  const blocked = message.match(/^fetch failed: (\d+)/);
  if (blocked) {
    const code = Number(blocked[1]);
    if (code === 403 || code === 401)
      return `That site blocked the request (${code}). It doesn’t allow automated fetching.`;
    if (code === 404) return "That page doesn’t exist (404). Check the link.";
    if (code === 429)
      return "That site is rate-limiting us (429). Try again in a few minutes.";
    if (code >= 500)
      return `That site is having problems (${code}). Try again later.`;
    return `Couldn’t fetch that page (${code}).`;
  }

  if (message.startsWith("fetch error")) {
    if (/timeout|abort|timed out/i.test(message))
      return "That page took too long to respond.";
    return "Couldn’t reach that page. Check the link and your connection.";
  }

  if (message === "no recipe found on page")
    return "No recipe found on that page. It might be a video, a roundup, or a listing page.";
  if (message === "invalid url")
    return "That doesn’t look like a valid link. Paste the full URL.";
  if (message === "unauthorized")
    return "Import rejected the secret — check IMPORT_SECRET in .env.local.";

  return message || `Import failed (${status}).`;
}
