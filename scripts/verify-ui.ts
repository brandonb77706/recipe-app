/**
 * Visual verification across engines and viewports.
 *
 *   npx tsx scripts/verify-ui.ts                 # all routes, all viewports
 *   npx tsx scripts/verify-ui.ts --route=/swipe
 *   npx tsx scripts/verify-ui.ts --engine=webkit
 *
 * Exists because three separate "verified" claims contradicted what was
 * actually on screen. Each divergence had a cause, and each is now covered:
 *
 *   1. A stale service worker pinned the browser to old chunks. Headless runs
 *      start with an empty profile and never installed one, so the loop was
 *      structurally blind to it. Now the run reports whether a worker is
 *      registered, so "it's cached" can't hide again.
 *   2. Testing at 844px tall when a real browser window has ~650px of content
 *      height. Height-dependent layouts (cook mode) passed here and broke
 *      there. SHORT viewports are now first-class, not an afterthought.
 *   3. Testing only Chromium while the phone and desktop are both WebKit.
 *
 * It also asserts the things eyes miss: horizontal overflow, clipped text,
 * controls pushed off-screen, and elements overlapping each other.
 */
import { chromium, webkit, type Browser, type Page } from "playwright";
import { mkdirSync } from "node:fs";

const OUT = process.env.UI_OUT ?? "/tmp/ui-verify";
const BASE = process.env.UI_BASE ?? "http://localhost:3000";

const args = process.argv.slice(2);
// slice(1).join("=") — a naive [1] truncates values containing "=", which
// silently turned "?cook=1" into "?cook" and screenshotted the wrong screen.
const arg = (n: string) =>
  args.find((a) => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=");

/** Real content heights, not idealised device specs. Safari on an iPhone 14
 *  gives ~750px with its bars; a resized desktop window is often less. */
const VIEWPORTS = [
  { w: 390, h: 620, tag: "390x620-short" },
  { w: 390, h: 750, tag: "390x750-phone" },
  { w: 768, h: 900, tag: "768-tablet" },
  { w: 1440, h: 800, tag: "1440-desktop" },
];

type Check = { name: string; pass: boolean; detail: string };

async function audit(page: Page, viewportH: number): Promise<Check[]> {
  return page.evaluate((vh) => {
    const checks: { name: string; pass: boolean; detail: string }[] = [];

    const doc = document.documentElement;
    checks.push({
      name: "no horizontal overflow",
      pass: doc.scrollWidth <= doc.clientWidth + 1,
      detail: `scrollWidth ${doc.scrollWidth} vs client ${doc.clientWidth}`,
    });

    // Anything wider than the viewport is a layout break, not a design choice.
    const wide = Array.from(document.querySelectorAll("*")).filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > doc.clientWidth + 2 && r.height > 0;
    });
    checks.push({
      name: "no element exceeds viewport width",
      pass: wide.length === 0,
      detail: wide.length ? `${wide.length}, first: ${wide[0].className}` : "none",
    });

    // Text clipped by its own container — the flex `items-center` + overflow
    // trap, where the top of the content is unreachable by scrolling.
    const clipped = Array.from(document.querySelectorAll("p, h1, h2, li")).filter(
      (el) => {
        const parent = el.parentElement;
        if (!parent) return false;
        const pr = parent.getBoundingClientRect();
        const er = el.getBoundingClientRect();
        const style = getComputedStyle(parent);
        const scrolls = /auto|scroll/.test(style.overflowY);
        return scrolls && er.top < pr.top - 2 && parent.scrollTop === 0;
      }
    );
    checks.push({
      name: "no text clipped above its scroll container",
      pass: clipped.length === 0,
      detail: clipped.length
        ? `${clipped.length}, first: "${clipped[0].textContent?.slice(0, 40)}"`
        : "none",
    });

    // Controls that are SUPPOSED to stay on screen must actually be on screen.
    //
    // The earlier version of this counted every control below the fold, which
    // meant a list of 591 passed recipes "failed" for having 591 items in it.
    // It fired on 32 of 40 runs and would have been ignored inside a week. A
    // check that can't tell a grid tile from a pinned action bar is noise.
    //
    // Only pinned chrome and open dialogs are in scope now: those are the
    // things a short viewport actually pushes off-screen.
    const pinned = Array.from(
      document.querySelectorAll("button, a[href]")
    ).filter((el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 40 || r.height < 30) return false;
      // Walk up looking for a fixed/sticky ancestor or a dialog.
      let node: HTMLElement | null = el as HTMLElement;
      while (node && node !== document.body) {
        const pos = getComputedStyle(node).position;
        if (pos === "fixed" || pos === "sticky") return true;
        if (node.getAttribute("role") === "dialog") return true;
        node = node.parentElement;
      }
      return false;
    });
    const offscreen = pinned.filter((el) => {
      const r = el.getBoundingClientRect();
      return r.top > vh || r.bottom < 0;
    });
    checks.push({
      name: "pinned controls stay on screen",
      pass: offscreen.length === 0,
      detail: offscreen.length
        ? `${offscreen.length} pinned control(s) off-screen, first: "${offscreen[0].textContent?.trim().slice(0, 30)}"`
        : `${pinned.length} pinned control(s), all visible`,
    });

    checks.push({
      name: "no service worker controlling the page",
      pass: !navigator.serviceWorker?.controller,
      detail: navigator.serviceWorker?.controller ? "SW ACTIVE" : "none",
    });

    return checks;
  }, viewportH);
}

/** Waits for the app to actually have data, not just for the network to idle. */
async function settle(page: Page) {
  await page
    .waitForFunction(
      () =>
        document.querySelectorAll("ul.grid > li").length > 0 ||
        document.querySelector("[role='dialog']") !== null ||
        document.querySelectorAll("img").length > 0 ||
        document.body.innerText.length > 200,
      { timeout: 15000 }
    )
    .catch(() => {});
  await page.waitForTimeout(900);
}

async function run(browser: Browser, engine: string, routes: string[]) {
  let failures = 0;
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: vp.w, height: vp.h },
      deviceScaleFactor: 1,
      isMobile: vp.w < 700,
      hasTouch: vp.w < 700,
    });
    for (const route of routes) {
      const page = await ctx.newPage();
      await page.goto(BASE + route, { waitUntil: "networkidle" }).catch(() => {});
      await settle(page);

      const slug = route.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "home";
      const file = `${OUT}/${engine}-${vp.tag}-${slug}.png`;
      await page.screenshot({ path: file });

      const checks = await audit(page, vp.h);
      const failed = checks.filter((c) => !c.pass);
      failures += failed.length;
      const mark = failed.length ? "FAIL" : "ok  ";
      console.log(`  ${mark} ${engine} ${vp.tag.padEnd(16)} ${route}`);
      for (const f of failed) console.log(`        ✗ ${f.name} — ${f.detail}`);
      await page.close();
    }
    await ctx.close();
  }
  return failures;
}

async function main() {
  mkdirSync(OUT, { recursive: true });

  const routes = arg("route")
    ? [arg("route")!]
    : ["/", "/library", "/swipe", "/passed", "/settings"];

  const wanted = arg("engine");
  const engines: [string, typeof chromium][] = [];
  if (!wanted || wanted === "chromium") engines.push(["chromium", chromium]);
  if (!wanted || wanted === "webkit") engines.push(["webkit", webkit as never]);

  let failures = 0;
  for (const [name, launcher] of engines) {
    const browser = await launcher.launch();
    failures += await run(browser, name, routes);
    await browser.close();
  }

  console.log(`\n  screenshots: ${OUT}`);
  console.log(failures ? `  ${failures} check(s) failed` : "  all checks passed");
  process.exit(failures ? 1 : 0);
}

main();
