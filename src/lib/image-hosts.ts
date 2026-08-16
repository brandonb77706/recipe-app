/**
 * Hosts next/image is allowed to optimise.
 *
 * Shared by next.config.ts (which builds remotePatterns from it) and
 * recipe-image.tsx (which checks it before rendering an <Image>), so the two
 * can't drift. A host in one and not the other throws at render time.
 *
 * This list can never be complete: hand-imported recipes come from arbitrary
 * blogs, and one already does (healthyfitnessmeals.com). That's why the
 * component degrades to a plain <img> for unknown hosts rather than failing —
 * an unoptimised photo is a fine outcome, a thrown error is not.
 *
 * It is NOT "**" because an open allowlist turns the deployed image optimiser
 * into a free proxy for any image on the internet.
 */
export const IMAGE_HOSTS = [
  "budgetbytes.com",
  "minimalistbaker.com",
  "cookieandkate.com",
  "loveandlemons.com",
  "pinchofyum.com",
  "halfbakedharvest.com",
  "cafedelites.com",
  "theseasonedmom.com",
  "thecountrycook.net",
  "thestayathomechef.com",
  "dinneratthezoo.com",
  "plainchicken.com",
  // Stock photography used by scripts/backfill-images.ts
  "images.pexels.com",
  "upload.wikimedia.org",
] as const;

/** True when next/image can handle this URL. Subdomains count (cdn.*). */
export function isOptimisableHost(src: string | null): boolean {
  if (!src) return false;
  try {
    const host = new URL(src).hostname.toLowerCase();
    return IMAGE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}
