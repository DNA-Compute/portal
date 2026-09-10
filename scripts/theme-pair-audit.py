#!/usr/bin/env python3
"""Static contrast audit of self-contained bg/text class pairs.

The rendered audit only reaches pages that need no session. This one reaches
every page, by resolving Tailwind class names through the theme rather than
through a browser.

It only judges elements that set BOTH their own background and their own text
colour in the same className. Those are self-contained and can be decided with
certainty; an element that inherits either one from an ancestor cannot be, and
is left alone rather than guessed at.
"""
import re, sys, pathlib, math
from collections import Counter

TW_THEME = pathlib.Path(sys.argv[1])
SRC = pathlib.Path(sys.argv[2])

# ── oklch -> sRGB ────────────────────────────────────────────────────────────
def oklch_to_srgb(L, C, H):
    h = math.radians(H)
    a, b = C * math.cos(h), C * math.sin(h)
    l_ = L + 0.3963377774 * a + 0.2158037573 * b
    m_ = L - 0.1055613458 * a - 0.0638541728 * b
    s_ = L - 0.0894841775 * a - 1.2914855480 * b
    l, m, s = l_**3, m_**3, s_**3
    r = +4.0767416621*l - 3.3077115913*m + 0.2309699292*s
    g = -1.2684380046*l + 2.6097574011*m - 0.3413193965*s
    bl = -0.0041960863*l - 0.7034186147*m + 1.7076147010*s
    def enc(c):
        c = max(0.0, min(1.0, c))
        c = 12.92*c if c <= 0.0031308 else 1.055*(c**(1/2.4)) - 0.055
        return round(max(0.0, min(1.0, c)) * 255)
    return (enc(r), enc(g), enc(bl))

# ── Tailwind's own ramps ─────────────────────────────────────────────────────
COLORS = {}
theme = TW_THEME.read_text()
for m in re.finditer(r'--color-([a-z]+)-(\d+):\s*oklch\(([\d.]+)%?\s+([\d.]+)\s+([\d.]+)', theme):
    name, shade, L, C, H = m.group(1), m.group(2), float(m.group(3)), float(m.group(4)), float(m.group(5))
    COLORS[f"{name}-{shade}"] = oklch_to_srgb(L/100 if L > 1 else L, C, H)
COLORS["white"] = (255, 255, 255)
COLORS["black"] = (0, 0, 0)

# ── The DNA theme's overrides ────────────────────────────────────────────────
INK        = (7, 17, 15)
INK_SOFT   = (12, 25, 22)
INK_RAISE  = (16, 32, 27)
ACID       = (200, 255, 61)
ACID_DEEP  = (159, 219, 20)
MINT       = (119, 242, 198)

NEUTRAL = {
    "50": (INK_SOFT, 1.0), "100": (INK_RAISE, 1.0), "200": ((22, 41, 35), 1.0),
    "300": ((30, 55, 47), 1.0),
    "400": ((255, 255, 255), 0.55), "500": ((255, 255, 255), 0.62),
    "600": ((255, 255, 255), 0.72), "700": ((255, 255, 255), 0.82),
    "800": ((255, 255, 255), 0.92), "900": ((255, 255, 255), 1.0),
    "950": ((255, 255, 255), 1.0),
}
TOKENS = {
    "var(--ink)": (INK, 1.0), "var(--ink-soft)": (INK_SOFT, 1.0),
    "var(--ink-raise)": (INK_RAISE, 1.0), "var(--ink-sink)": ((5, 12, 11), 1.0),
    "var(--acid)": (ACID, 1.0), "var(--acid-deep)": (ACID_DEEP, 1.0),
    "var(--acid-ink)": ((70, 102, 10), 1.0), "var(--mint)": (MINT, 1.0),
    "var(--fg)": ((255, 255, 255), 1.0), "var(--fg-soft)": ((255, 255, 255), 0.82),
    "var(--fg-muted)": ((255, 255, 255), 0.66), "var(--fg-faint)": ((255, 255, 255), 0.40),
    "var(--line)": ((255, 255, 255), 0.12), "var(--line-strong)": ((255, 255, 255), 0.22),
    "var(--panel)": (INK_SOFT, 1.0),
}

def resolve(prop, value):
    """(rgb, alpha) for a utility's colour, after the theme, or None."""
    alpha = 1.0
    if "/" in value:
        value, a = value.rsplit("/", 1)
        try: alpha = int(a) / 100
        except ValueError: return None
    if value.startswith("[") and value.endswith("]"):
        inner = value[1:-1]
        if inner in TOKENS:
            rgb, a2 = TOKENS[inner]
            return rgb, alpha * a2
        if re.fullmatch(r"#[0-9a-fA-F]{6}", inner):
            return tuple(int(inner[i:i+2], 16) for i in (1, 3, 5)), alpha
        return None
    # bg-white is redirected to the panel by the utilities layer; text-white is not.
    if value == "white":
        return (INK_SOFT, alpha) if prop == "bg" else ((255, 255, 255), alpha)
    if value == "black":
        return (INK, alpha) if prop == "bg" else ((0, 0, 0), alpha)
    m = re.fullmatch(r"(gray|zinc|slate)-(\d+)", value)
    if m and m.group(2) in NEUTRAL:
        rgb, a2 = NEUTRAL[m.group(2)]
        return rgb, alpha * a2
    if value in COLORS:
        return COLORS[value], alpha
    return None

def comp(fg, a, bg):
    return tuple(fg[i]*a + bg[i]*(1-a) for i in range(3))

def rl(c):
    v = [x/255 for x in c]
    v = [x/12.92 if x <= 0.04045 else ((x+0.055)/1.055)**2.4 for x in v]
    return 0.2126*v[0] + 0.7152*v[1] + 0.0722*v[2]

def ratio(a, b):
    L1, L2 = rl(a), rl(b)
    return (max(L1, L2)+0.05) / (min(L1, L2)+0.05)

CLS = re.compile(r'className=(?:"([^"]*)"|\{`([^`]*)`\})', re.S)
BG = re.compile(r'(?:^|\s)bg-(\[[^\]]+\]|[a-z]+-\d+(?:/\d+)?|white|black)(?:/\d+)?(?=\s|$)')
TX = re.compile(r'(?:^|\s)text-(\[[^\]]+\]|[a-z]+-\d+(?:/\d+)?|white|black)(?:/\d+)?(?=\s|$)')

findings, checked, skipped = [], 0, Counter()
for f in sorted(SRC.rglob("*.tsx")):
    src = f.read_text()
    for m in CLS.finditer(src):
        cls = " ".join((m.group(1) or m.group(2) or "").split())
        # Only same-element pairs, and ignore hover:/focus: variants for the
        # resting state.
        base = " ".join(t for t in cls.split() if ":" not in t)
        bg_m, tx_m = BG.search(base), TX.search(base)
        if not (bg_m and tx_m):
            continue
        bg_r, tx_r = resolve("bg", bg_m.group(1)), resolve("text", tx_m.group(1))
        if not bg_r or not tx_r:
            skipped[bg_m.group(1) if not bg_r else tx_m.group(1)] += 1
            continue
        checked += 1
        bg = comp(bg_r[0], bg_r[1], INK)
        fg = comp(tx_r[0], tx_r[1], bg)
        cr = ratio(fg, bg)
        large = bool(re.search(r'\btext-(xl|2xl|3xl|4xl|5xl)\b', base)) or \
                (bool(re.search(r'\btext-lg\b', base)) and bool(re.search(r'\bfont-(bold|semibold|extrabold)\b', base)))
        need = 3.0 if large else 4.5
        if cr < need:
            line = src[:m.start()].count("\n") + 1
            findings.append((cr, need, str(f.relative_to(SRC)), line,
                             f"bg-{bg_m.group(1)}", f"text-{tx_m.group(1)}"))

findings.sort()
print(f"checked {checked} self-contained bg/text pairs across {len(list(SRC.rglob('*.tsx')))} components")
print(f"{len(findings)} below their WCAG threshold\n")
for cr, need, path, line, b, t in findings:
    flag = "INVISIBLE" if cr < 1.6 else "low"
    print(f"  {cr:5.2f}:1 (need {need})  {flag:9}  {path}:{line}")
    print(f"           {b}  +  {t}")
if skipped:
    print(f"\nunresolvable colours (not judged): {sum(skipped.values())}")
    for k, v in skipped.most_common(6):
        print(f"    {v:4}  {k}")
