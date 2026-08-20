import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { verifyAccessToken } from "@/lib/verify-jwt";
import { sessionCookieOptions } from "@/lib/cookie-options";

/**
 * Next 16 renamed the `middleware` file convention to `proxy`. Same execution
 * point — before a route renders — but the export must be named `proxy`, and a
 * file called `middleware.ts` is silently ignored rather than erroring.
 *
 * Two jobs here:
 *
 *   1. Refresh the Supabase session. Access tokens are short-lived; without a
 *      refresh on each request the app signs you out mid-session. This has to
 *      happen somewhere that can write cookies, and Server Components can't.
 *   2. Bounce unauthenticated traffic. Until this existed the app was an
 *      unauthenticated write API — anyone with the URL could save, delete, or
 *      drive imports that spend Anthropic credits.
 */
export async function proxy(request: NextRequest) {
  // Every ?timing=true number we have ever collected measures only the route
  // handler. The proxy runs BEFORE it and calls getUser(), which is a network
  // round trip to Supabase on every request — so the real user-facing latency
  // has always been proxy + application, and we were reporting half of it.
  const proxyStart = Date.now();
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    (process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL)!,
    process.env.SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(toSet) {
          for (const { name, value } of toSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of toSet) {
            response.cookies.set(name, value, sessionCookieOptions(options));
          }
        },
      },
    }
  );

  /**
   * Two jobs, and they need separating.
   *
   * getUser() both VALIDATES the token and REFRESHES it as a side effect.
   * Validation can be done locally against the published JWKS for nothing;
   * refreshing genuinely needs the network. Doing both on every request cost a
   * round trip per request for a refresh that is only due once an hour.
   *
   * So: verify locally, and only reach for the network when the token is
   * actually close to expiring — or when local verification can't vouch for it,
   * in which case we fall back rather than guess.
   */
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  const verified = await verifyAccessToken(token);

  const REFRESH_WINDOW_S = 5 * 60;
  const needsRefresh =
    !verified || verified.expiresAt - Date.now() / 1000 < REFRESH_WINDOW_S;

  let user: { id: string } | null = verified
    ? { id: verified.id }
    : null;

  if (needsRefresh && token) {
    // Network path: revalidates AND rotates the token, writing new cookies
    // through the setAll handler above.
    const { data } = await supabase.auth.getUser();
    user = data.user ? { id: data.user.id } : null;
  } else if (!token) {
    user = null;
  }

  const { pathname } = request.nextUrl;
  // /api/auth/* must be reachable WITHOUT a session — it's how you get one.
  // Missing this 401s the sign-in request itself and login stops working
  // entirely, with no error that points at the cause.
  const isAuthRoute =
    pathname.startsWith("/login") ||
    pathname.startsWith("/auth") ||
    pathname.startsWith("/api/auth");

  if (!user && !isAuthRoute) {
    // API routes get a 401 they can handle; pages get sent to the login form.
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    }
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    // Come back where you were once signed in.
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  if (user && pathname.startsWith("/login")) {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    return NextResponse.redirect(url);
  }

  // Hand the cost downstream so /api/discover?timing=true can report it.
  response.headers.set("x-proxy-ms", String(Date.now() - proxyStart));
  return response;
}

export const config = {
  matcher: [
    /**
     * Everything except static assets and the PWA files.
     *
     * sw.js, manifest and icons must stay public: iOS fetches them without the
     * session cookie when installing to the home screen, and a redirect to
     * /login there makes the app un-installable rather than merely locked.
     */
    "/((?!_next/static|_next/image|favicon.ico|sw.js|manifest.webmanifest|icon-192.png|apple-touch-icon.png|ai-chef.jpg|.*\\.(?:png|jpg|jpeg|svg|webp)$).*)",
  ],
};
