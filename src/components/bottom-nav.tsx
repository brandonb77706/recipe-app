"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Fixed bottom navigation.
 *
 * Replaces the per-page header nav, which overflowed the viewport at 390px —
 * "Discover" plus three buttons didn't fit, and the settings gear was clipped
 * off the right edge. Putting navigation at the bottom fixes that permanently
 * and puts it in thumb reach, which is the whole point on a phone held in one
 * hand in a kitchen.
 *
 * It also reclaims the top of every screen for content. Discover was spending
 * 44% of the first viewport on chrome before a single photo appeared.
 *
 * Deliberately not terracotta: the accent marks one *action* per screen, and
 * navigation isn't an action. Active state is ink weight, not colour.
 */
const TABS = [
  {
    href: "/",
    label: "Discover",
    // Grid of four — the shape of the dense feed it leads to.
    icon: (
      <>
        <rect x="3" y="3" width="7.5" height="7.5" rx="1.5" />
        <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" />
        <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" />
        <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" />
      </>
    ),
  },
  {
    href: "/swipe",
    label: "Swipe",
    icon: (
      <>
        <rect x="6" y="3" width="12" height="16" rx="2.5" />
        <path d="M3.5 7v9.5A3.5 3.5 0 007 20h9" />
      </>
    ),
  },
  {
    href: "/library",
    label: "Library",
    icon: (
      <path d="M4 4.5A1.5 1.5 0 015.5 3H18a2 2 0 012 2v14a2 2 0 01-2 2H5.5A1.5 1.5 0 014 19.5v-15zM8 3v9l3-2 3 2V3" />
    ),
  },
] as const;

export function BottomNav() {
  const pathname = usePathname();

  // Cook mode and onboarding are full-screen tasks — navigation would be an
  // invitation to abandon them halfway. On /login every tab just bounces back
  // here, so the nav is three dead ends.
  if (pathname === "/onboarding" || pathname === "/login") return null;

  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-paper/95 backdrop-blur-md"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <ul className="mx-auto flex h-[var(--nav-h)] max-w-md items-stretch">
        {TABS.map((tab) => {
          const active =
            tab.href === "/" ? pathname === "/" : pathname.startsWith(tab.href);
          return (
            <li key={tab.href} className="flex-1">
              <Link
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={`flex h-full flex-col items-center justify-center gap-1 transition ${
                  active ? "text-ink" : "text-muted"
                }`}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={active ? 2 : 1.6}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="h-6 w-6"
                >
                  {tab.icon}
                </svg>
                <span
                  className={`text-[11px] leading-none ${
                    active ? "font-semibold" : ""
                  }`}
                >
                  {tab.label}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
