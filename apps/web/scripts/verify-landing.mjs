#!/usr/bin/env node
/**
 * Structural + built-output checks for the marketing landing.
 * Drives real shipped files under apps/web — not reimplemented expectations.
 *
 * Usage (from apps/web): node scripts/verify-landing.mjs
 * Optional: LANDING_URL=http://127.0.0.1:PORT node scripts/verify-landing.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fail = (msg) => {
  console.error("FAIL:", msg);
  process.exitCode = 1;
};
const ok = (msg) => console.log("OK:", msg);

// AnyRouter/shadcn design anchors: amber primary + neutral scale + radius.
const BRAND_ANCHORS = ["oklch(0.555 0.163 48.998)", "oklch(0.145 0 0)", "--radius: 0.625rem"];

// --- Source: global.css tokens ---
const cssPath = join(root, "src/styles/global.css");
const css = readFileSync(cssPath, "utf8");
// Brand fonts are now Inter + JetBrains Mono (AnyRouter/shadcn stack),
// self-hosted via fontsource.
if (!css.includes('"Inter Variable"') || !css.includes('"JetBrains Mono Variable"')) {
  fail("global.css must set Inter Variable (sans/display) + JetBrains Mono Variable");
} else {
  ok("global.css Inter Variable + JetBrains Mono tokens");
}
if (css.includes("Source Serif") || css.includes("DM Sans") || css.includes("Poppins") || css.includes("Lora")) {
  fail("global.css must not default marketing to Source Serif / DM Sans / Poppins / Lora");
} else {
  ok("no legacy Console/marketing font families as marketing default in global.css");
}
for (const anchor of BRAND_ANCHORS) {
  if (!css.toLowerCase().includes(anchor.toLowerCase())) {
    fail(`missing design anchor "${anchor}" in global.css`);
  }
}
if (!process.exitCode) ok("shadcn design anchors present in global.css");

// --- Source: Base.astro font load ---
const base = readFileSync(join(root, "src/layouts/Base.astro"), "utf8");
// Fonts are self-hosted (fontsource import in global.css) — no Google Fonts
// <link> for Poppins/Lora any more. Assert we dropped the legacy link and
// don't load Source Serif / DM Sans.
if (/fonts\.googleapis\.com\/css2\?family=Poppins|family=Lora/.test(base)) {
  fail("Base.astro still loads Google Fonts Poppins + Lora");
} else {
  ok("Base.astro no longer loads Google Fonts Poppins + Lora");
}
if (/Source\+Serif|DM\+Sans/.test(base)) {
  fail("Base.astro still loads Source Serif / DM Sans for marketing");
} else {
  ok("Base.astro free of Source Serif / DM Sans font URLs");
}
if (!css.includes("@fontsource-variable/inter")) {
  fail("global.css must self-host Inter via @fontsource-variable/inter");
}

// --- Source: index.astro sections ---
const index = readFileSync(join(root, "src/pages/index.astro"), "utf8");
// The landing was split into deep-dive pages (/how-it-works, /features, …);
// these are the sections that stayed on the home page.
const requiredHeadings = [
  "What Open Managed Agents is",
  "See it run",
  "What one request touches",
  "Any model, any sandbox",
  "Dig deeper",
  "Get started",
];
for (const h of requiredHeadings) {
  if (!index.includes(h)) fail(`landing missing section heading: ${h}`);
}
if (!index.includes("Agent") || !index.includes("Session") || !index.includes("Environment") || !index.includes("Vault")) {
  fail("landing must explain Agent / Session / Environment / Vault");
}
// Schematic vocabulary: the interactive request-path walkthrough (which
// renders the blueprint .arch-node pipeline) + the provider-fan visual that
// carry the architecture + reach sections. The arch-node markup now lives in
// the RequestFlowInteractive island, not inline in index.astro.
if (!index.includes("RequestFlowInteractive") || !index.includes("ProviderFan")) {
  fail("landing must include the interactive request-path + provider-fan visual structure");
}
// Hosted CTA may be app root (signed-in → shell, signed-out → login bounce)
// or the explicit /login path — both are valid.
if (
  !index.includes("github.com/duyet/oma") ||
  !index.includes("app.oma.duyet.net") ||
  !index.includes("docs.oma.duyet.net")
) {
  fail("primary CTAs (GitHub, hosted, docs) must remain");
}
// Flexibility section: #reach is canonical; #layers must remain as a stable
// alias so external/old deep links still resolve after the merge.
if (!/id=["']reach["']/.test(index) || !/id=["']layers["']/.test(index)) {
  fail("landing must keep id=\"reach\" and alias id=\"layers\" on the flexibility section");
}
// Hosted CTA wording: nav/footer/hero say "Try hosted", not the old
// "Dashboard →" label (dual-ended with login bounce confusion).
const footer = readFileSync(join(root, "src/components/Footer.astro"), "utf8");
for (const [name, src] of [
  ["index.astro", index],
  ["Base.astro", base],
  ["Footer.astro", footer],
]) {
  if (/\bDashboard\s*→/.test(src)) fail(`${name}: stale "Dashboard →" CTA copy`);
}
if (!base.includes("Try hosted") || !footer.includes("Try hosted") || !index.includes("Try hosted")) {
  fail("Base/Footer/index must expose \"Try hosted\" CTA label");
}
// Hero leads with the H1 value prop; HowItFits is the supporting diagram
// below (not a first-viewport billboard, no negative-margin page overflow).
if (!index.includes("HowItFits") || !index.includes("self-hosted agent platform")) {
  fail("landing hero must include HowItFits + product pitch");
}
const h1Needle = "The self-hosted agent platform for any LLM provider and any sandbox";
const h1Pos = index.indexOf(h1Needle);
const fitsPos = index.indexOf("<HowItFits");
const productPos = index.indexOf('id="what-is-oma"');
if (h1Pos < 0 || fitsPos < 0 || h1Pos > fitsPos) {
  fail("H1 value prop must appear above HowItFits");
}
if (productPos < 0 || fitsPos > productPos) {
  fail("HowItFits must still sit above the rest of the page body");
}
if (/lg:-mx-12|xl:-mx-24/.test(index)) {
  fail("HowItFits must not use negative-margin bleed (causes page overflow)");
}
if (!css.includes(".site-container") || !/max-width:\s*64rem/.test(css)) {
  fail("global.css must define .site-container at 64rem (max-w-5xl)");
}
if (/max-w-6xl|max-w-7xl/.test(index)) {
  fail("landing sections must share .site-container, not a wider max-w-*");
}
if (!index.includes("site-container")) {
  fail("landing must use the shared site-container class");
}
if (!process.exitCode) ok("landing source sections + concepts + viz + CTAs + hero + #layers alias");

// --- Marketing subpages: same content column as the homepage ---
const legacyColumn = /max-w-5xl\s+mx-auto\s+px-4|max-w-6xl|max-w-7xl/;
const subpageRoots = [
  join(root, "src/pages/how-it-works.astro"),
  join(root, "src/pages/stats.astro"),
  join(root, "src/pages/infrastructure.astro"),
  join(root, "src/pages/use-cases.astro"),
  join(root, "src/pages/brand.astro"),
  join(root, "src/pages/features"),
];
for (const path of subpageRoots) {
  if (!existsSync(path)) {
    fail(`expected marketing subpage missing: ${path.replace(root + "/", "")}`);
    continue;
  }
  const files =
    path.endsWith("features") ?
      ["index.astro", "agent-sandbox.astro", "coding-agents.astro", "local-machine.astro", "private-kubernetes.astro"].map(
        (name) => join(path, name),
      )
    : [path];
  for (const file of files) {
    if (!existsSync(file)) continue;
    const rel = file.replace(root + "/", "");
    const src = readFileSync(file, "utf8");
    if (legacyColumn.test(src)) {
      fail(`${rel}: must use .site-container, not legacy max-w-* column classes`);
    }
    if (/section class="site-container/.test(src)) {
      fail(`${rel}: site-container belongs on inner content, not on <section> (keep sections full-bleed)`);
    }
    if (!src.includes("site-container")) {
      fail(`${rel}: marketing subpage must wrap inner content in site-container`);
    }
  }
}
if (!process.exitCode) ok("marketing subpages use site-container (no legacy max-w-* columns)");

// --- Built dist (if present) ---
const distIndex = join(root, "dist/index.html");
if (existsSync(distIndex)) {
  const html = readFileSync(distIndex, "utf8");
  // Inter is self-hosted: the built HTML references the fontsource CSS
  // (and the @font-face family name), not a Google Fonts URL.
  if (!/Inter/i.test(html)) {
    fail("built dist/index.html must reference Inter");
  } else {
    ok("dist/index.html references Inter");
  }
  if (!html.includes("What Open Managed Agents is") || !html.includes("Any model, any sandbox")) {
    fail("built HTML missing product/reach explainer headings");
  } else {
    ok("built HTML has product + reach explainers");
  }
  if (!html.includes("arch-node")) {
    fail("built HTML missing architecture viz structure");
  } else {
    ok("built HTML has architecture viz classes");
  }
} else {
  console.log("SKIP: dist/index.html not built yet (run build first for full check)");
}

// --- Optional live URL (dual-fetch caller can pass LANDING_URL) ---
const url = process.env.LANDING_URL;
if (url) {
  for (let i = 1; i <= 2; i++) {
    const res = await fetch(url);
    const body = await res.text();
    if (!res.ok) fail(`fetch #${i} ${url} → HTTP ${res.status}`);
    if (!/Open Managed Agents|oma/i.test(body)) fail(`fetch #${i}: missing product title`);
    if (!body.includes("Any model, any sandbox") && !body.includes("What one request touches")) {
      fail(`fetch #${i}: missing architecture/reach heading`);
    }
    if (!/Inter/i.test(body)) fail(`fetch #${i}: missing Inter font ref`);
    if (!process.exitCode) ok(`live fetch #${i} ${url} observables ok`);
  }
}

if (process.exitCode) {
  console.error("\nverify-landing: FAILED");
  process.exit(1);
}
console.log("\nverify-landing: PASSED");
