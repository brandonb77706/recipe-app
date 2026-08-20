import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { sessionCookieOptions } from "@/lib/cookie-options";

/**
 * Sign-out. Needed server-side for the same reason as sign-in: the session
 * cookie is httpOnly, so the browser can't clear it itself.
 */
export async function POST(req: NextRequest) {
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

  await supabase.auth.signOut();
  return response;
}
