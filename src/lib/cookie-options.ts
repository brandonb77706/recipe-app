import "server-only";
import type { CookieOptions } from "@supabase/ssr";

/**
 * Cookie flags forced on every Supabase session cookie we write.
 *
 * @supabase/ssr defaults to httpOnly:false because its BROWSER client has to
 * read the session to attach it to its own requests. This app has no browser
 * client — every Supabase call happens server-side, which is a standing
 * constraint of the project — so nothing in the page needs to read it, and
 * leaving it readable only widens the blast radius of an XSS.
 *
 * What that changes: the cookie holds the access token AND the long-lived
 * REFRESH token in plain base64. Readable by script meant any XSS on this
 * origin could mint new sessions long after the stolen access token expired.
 * httpOnly removes that: script cannot see the cookie at all, only the server
 * and the browser's own request machinery can.
 *
 * It is NOT encryption. The value is still base64 JSON — anyone who obtains
 * the cookie by other means (a stolen device, a compromised server) can read
 * it. httpOnly narrows who can obtain it in the first place.
 */
export function sessionCookieOptions(base: CookieOptions = {}): CookieOptions {
  return {
    ...base,
    httpOnly: true,
    // Localhost is plain http; anything deployed is https-only.
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
  };
}
