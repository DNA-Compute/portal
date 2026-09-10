import { test, expect } from "@playwright/test";

/**
 * Guards the theme against invisible controls.
 *
 * The portal styles itself with literal Tailwind utilities (bg-white,
 * text-zinc-900) and the DNA theme remaps the scale those utilities resolve
 * against, rather than editing ~3,800 call sites. That works because the ramps
 * are used positionally - low shades are surfaces, high shades are text - but
 * any ramp that gets remapped while a paired ramp does not produces text the
 * same colour as its own background.
 *
 * That is not a subtle regression. On 2026-09-10 the admin "Create Account"
 * button rendered at 1.15:1 and was invisible until hovered, because bg-white
 * had been remapped to the dark panel while text-zinc-900 was still near-black.
 * Three other elements on the same page had the same fault and nobody had
 * noticed them.
 *
 * The same day, the selected GPU card on /checkout shipped to production at
 * 1.06:1 - the mirror image. gray, zinc and slate were remapped but the fifteen
 * hue ramps were not, so bg-blue-50 stayed a near-white surface while the text
 * on it inherited the new white foreground. Roughly 479 bg-*-50/100/200
 * surfaces across the app are still in that state; the ones reachable without a
 * session are covered below, the rest are not yet.
 *
 * These pages are checked because they need no session. The signed-in product
 * is not covered here and still needs eyes on it.
 */

const PUBLIC_PAGES = [
  "/account",
  "/account?reason=session_expired",
  "/admin/login",
  "/admin/login?reason=session_expired",
  // /checkout was missing from this list when the theme first shipped, and that
  // is exactly how the bug below reached production: the selected GPU card sat
  // on bg-blue-50 while its text had become white and acid, measuring 1.06:1 on
  // the page a customer pays from. Any page a signed-out visitor can reach
  // belongs here.
  "/checkout",
  "/success",
  "/subscribed",
];

/** WCAG 2.1 relative luminance / contrast, with alpha composited onto the real
 *  painted background rather than assumed. */
const AUDIT = `() => {
  // Tailwind v4 emits lab()/oklab(), which a regex over the numbers reads as
  // RGB and gets badly wrong - it reported a light-amber banner at 1.34:1. A
  // 1x1 canvas resolves any CSS colour to sRGB, whatever syntax it arrived in.
  const cv = document.createElement("canvas");
  cv.width = cv.height = 1;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  const memo = new Map();
  const parse = (css) => {
    if (memo.has(css)) return memo.get(css);
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    const out = [d[0], d[1], d[2], d[3] / 255];
    memo.set(css, out);
    return out;
  };
  const comp = (fg, bg) => { const a = fg.length > 3 ? fg[3] : 1; return [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a)); };
  const rl = (c) => { const v = c.slice(0, 3).map((x) => x / 255).map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
  const ratio = (a, b) => { const L1 = rl(a), L2 = rl(b); return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05); };

  // Walk to the root collecting every painted layer, then composite downward so
  // a translucent panel over a dark page resolves to what the eye actually sees.
  const effBg = (el) => {
    let n = el; const chain = [];
    while (n && n !== document.documentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if ((c.length > 3 ? c[3] : 1) > 0) chain.push(c);
      n = n.parentElement;
    }
    let acc = [255, 255, 255];
    for (let i = chain.length - 1; i >= 0; i--) acc = comp(chain[i], acc);
    return acc;
  };

  const failures = [];
  const seen = new Set();
  for (const el of document.querySelectorAll("button, a, input, select, textarea, label, h1, h2, h3, p, span, div")) {
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 6) continue;
    const txt = (el.textContent || "").trim();
    if (!txt || txt.length > 60) continue;
    // Only the element that actually owns the text, not its ancestors.
    if ([...el.children].some((c) => (c.textContent || "").trim() === txt)) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) continue;

    const bg = effBg(el);
    const cr = ratio(comp(parse(cs.color), bg), bg);
    const size = parseFloat(cs.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
    // WCAG 1.4.3 exempts disabled controls, but "exempt" is not the same as
    // "unreadable": the disabled Continue to Payment button shipped at 1.14:1,
    // an ink label on a fill that had gone dark, so a customer could not read
    // what they were being asked to enable. Disabled controls are held to 3:1 -
    // dim enough to read as disabled, legible enough to read at all.
    const disabled =
      el.disabled === true || el.getAttribute("aria-disabled") === "true";
    const need = disabled ? 3 : large ? 3 : 4.5;
    if (cr >= need) continue;

    const key = el.tagName + "|" + txt.slice(0, 30);
    if (seen.has(key)) continue;
    seen.add(key);
    failures.push({ tag: el.tagName.toLowerCase(), text: txt.slice(0, 40), ratio: Number(cr.toFixed(2)), need });
  }
  return failures;
}`;

for (const path of PUBLIC_PAGES) {
  test(`no unreadable text on ${path}`, async ({ page }) => {
    await page.goto(path, { waitUntil: "networkidle" });
    const failures = await page.evaluate(AUDIT);
    const report = failures
      .map((f) => `  ${f.ratio}:1 (needs ${f.need})  <${f.tag}> "${f.text}"`)
      .join("\n");
    expect(failures, `contrast failures on ${path}:\n${report}`).toEqual([]);
  });
}
