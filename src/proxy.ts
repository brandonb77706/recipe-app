import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

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
            response.cookies.set(name, value, options);
          }
        },
      },
    }
  );

  // getUser() revalidates against the auth server and refreshes the token as a
  // side effect. Do not replace with getSession() — that only decodes the
  // cookie, which the client controls.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;
  const isAuthRoute = pathname.startsWith("/login") || pathname.startsWith("/auth");

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
