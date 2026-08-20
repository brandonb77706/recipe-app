import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { sessionCookieOptions } from "@/lib/cookie-options";

/**
 * Sign-in, moved off the browser.
 *
 * Previously the login page used createBrowserClient and signed in client-side,
 * which meant @supabase/ssr wrote the session cookie from JavaScript — and a
 * cookie JS can write is a cookie JS can read. That put the long-lived refresh
 * token within reach of any XSS on this origin.
 *
 * Doing it here lets the cookie be httpOnly. The password crosses the wire to
 * our own origin over HTTPS instead of going directly to Supabase, which is the
 * same trust boundary the rest of the app already uses — every other Supabase
 * call is server-side by design.
 */
export async function POST(req: NextRequest) {
  let email: string;
  let password: string;
  try {
    const body = await req.json();
    email = String(body?.email ?? "").trim();
    password = String(body?.password ?? "");
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  if (!email || !password) {
    return NextResponse.json(
      { error: "Enter your email and password." },
      { status: 400 }
    );
  }

  const response = NextResponse.json({ ok: true });

  const supabase = createServerClient(
    (process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL)!,
    process.env.SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return req.cookies.getAll();
        },
        setAll(toSet) {
          for (const { name, value, options } of toSet) {
            response.cookies.set(name, value, sessionCookieOptions(options));
          }
        },
      },
    }
  );

  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    // Deliberately not distinguishing "no such account" from "wrong password" —
    // that difference tells an attacker which emails exist.
    return NextResponse.json(
      { error: "That email and password didn't match." },
      { status: 401 }
    );
  }

  return response;
}
