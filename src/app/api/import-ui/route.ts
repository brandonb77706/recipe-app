import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";

/**
 * Thin proxy so the browser never sees IMPORT_SECRET. The client posts a URL
 * here; this attaches the secret server-side and forwards to /api/import.
 */
/**
 * Per-user hourly cap on imports.
 *
 * Auth already stops strangers, so this guards against the other spender: a
 * retry loop, a stuck client, or a mis-tap repeated. Each import can fall back
 * to an LLM extraction, so an unbounded loop spends real money.
 *
 * In-memory on purpose. Serverless instances don't share it, so the effective
 * cap is per-instance and a determined loop could exceed it — but the failure
 * it's built for (one client retrying) hits one instance, and the correct fix
 * for the rest is the spend cap in the Anthropic console. A Postgres counter
 * would be exact and cost a round trip on every import.
 */
const IMPORTS_PER_HOUR = 20;
const HOUR_MS = 60 * 60 * 1000;
const importLog = new Map<string, number[]>();

function overImportLimit(userId: string): boolean {
  const now = Date.now();
  const recent = (importLog.get(userId) ?? []).filter((t) => now - t < HOUR_MS);
  if (recent.length >= IMPORTS_PER_HOUR) {
    importLog.set(userId, recent);
    return true;
  }
  recent.push(now);
  importLog.set(userId, recent);
  return false;
}

export async function POST(req: NextRequest) {
  // Belt and braces: the proxy already 401s this route, but a route that
  // spends money should not depend on a matcher pattern staying correct.
  const auth = await requireUser();
  if ("response" in auth) return auth.response;

  if (overImportLimit(auth.user.id)) {
    return NextResponse.json(
      {
        error: `That's ${IMPORTS_PER_HOUR} imports in an hour — the limit. Try again later.`,
      },
      { status: 429 }
    );
  }

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
        // Forward the session. This is a real HTTP hop to our own origin, so
        // it passes through the proxy and through /api/import's own
        // requireUser() — without the cookie both reject it and import is
        // dead. Two independent checks on the money-spending route is the
        // point; dropping one to make the hop work would be the wrong fix.
        cookie: req.headers.get("cookie") ?? "",
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
