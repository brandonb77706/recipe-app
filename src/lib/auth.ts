import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

/**
 * Session-scoped Supabase access.
 *
 * This is the client every route that touches user data should use. It carries
 * the signed-in user's JWT, which means Row Level Security applies — the
 * service-role client in supabase.ts bypasses RLS entirely and is now reserved
 * for the scripts and for writing shared corpus content.
 *
 * That distinction is the whole point: with 30-odd `.eq("user_id", …)` call
 * sites, application-level filtering is one forgotten clause away from a
 * cross-user leak that returns data instead of an error. RLS makes the default
 * deny. It only works if the routes stop using the service key, so keep these
 * two clients clearly separated.
 *
 * (RLS policies land in step 3 of the auth migration. Until then this client
 * behaves the same as the old one — but the plumbing is in the right shape, so
 * turning policies on is a database change rather than a rewrite.)
 */
export async function supabaseServer() {
  const cookieStore = await cookies();

  return createServerClient(
    (process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL)!,
    process.env.SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(toSet) {
          try {
            for (const { name, value, options } of toSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Called from a Server Component, where cookies are read-only.
            // The proxy refreshes the session on every request, so a write
            // that lands here has already happened there.
          }
        },
      },
    }
  );
}

export type SessionUser = { id: string; email: string | null };

/** The signed-in user, or null. Never throws — callers decide what a missing
 *  session means. */
export async function getUser(): Promise<SessionUser | null> {
  const db = await supabaseServer();
  // getUser() revalidates against the auth server. getSession() only decodes
  // the cookie, which a client could forge, so it must not be used for
  // authorization decisions.
  const { data, error } = await db.auth.getUser();
  if (error || !data.user) return null;
  return { id: data.user.id, email: data.user.email ?? null };
}

/**
 * The signed-in user, or a 401 response to return directly:
 *
 *   const auth = await requireUser();
 *   if ("response" in auth) return auth.response;
 *   // auth.user.id is safe from here
 *
 * Returning the response rather than throwing keeps route handlers explicit —
 * a thrown error would need a catch in every route to avoid a 500 where a 401
 * is correct.
 */
export async function requireUser(): Promise<
  { user: SessionUser } | { response: NextResponse }
> {
  const user = await getUser();
  if (!user) {
    return {
      response: NextResponse.json(
        { error: "Not signed in." },
        { status: 401 }
      ),
    };
  }
  return { user };
}
