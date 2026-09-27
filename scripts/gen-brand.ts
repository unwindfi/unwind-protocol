/// Generates the unwind brand mark and favicon.
///
/// The mark is a seven-bladed pinwheel: each blade is a scoop that tapers to a
/// point at the hub and opens into a rounded bowl at the rim, curling as it
/// goes. Blades are sampled numerically — a centreline in polar coordinates,
/// offset either side by a width that grows along it — rather than written as
/// SVG arc commands, because arc flags on a hand-written path are easy to get
/// subtly wrong and the failure mode is a shape that reads as something else.
import * as fs from "fs";
import * as path from "path";

const ROOT = path.join(__dirname, "..");
const APP = path.join(ROOT, "app");

/// The brand violet (the purple rebrand, 2026-09-26; it was #0b5cff blue).
/// Chosen to keep the old blue's contrast: 5.3:1 under white text.
export const BRAND = "#6a4df4";
/// The far end of each blade's gradient, where the old blue was #0a46d8.
const DEEP = "#5a3fd0";
/// The pale middle of the gradient, a lilac to sit with DEEP (it was #dbe7ff, a pale blue).
const PALE = "#e4ddff";

const BLADES = 7;
const CX = 32, CY = 32;
const R_HUB = 4;    // where a blade's point sits, leaving the hub open
const R_RIM = 22.5;   // centre of the bowl at the far end
const CURL = -1.18;   // radians the centreline sweeps from hub to rim
const WIDTH = 8.6;    // half-width of the bowl

type P = { x: number; y: number };

const at = (t: number): P => {
  const r = R_HUB + (R_RIM - R_HUB) * t;
  const a = CURL * t;
  return { x: CX + r * Math.cos(a), y: CY + r * Math.sin(a) };
};

/// Zero at the point, full at the bowl, and most of the growth spent early so
/// the blade reads as a scoop rather than a wedge.
const halfWidth = (t: number) =>
  WIDTH * Math.pow(t, 1.1) * (1 - 0.45 * Math.pow(t, 6));

/// Unit left-hand normal, from a finite difference — the centreline has no
/// closed-form tangent worth writing out.
function normal(t: number): P {
  const h = 1e-4;
  const a = at(Math.max(0, t - h)), b = at(Math.min(1, t + h));
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: -dy / len, y: dx / len };
}

const fmt = (p: P) => `${p.x.toFixed(2)} ${p.y.toFixed(2)}`;

function blade(steps = 56): string {
  const right: P[] = [], left: P[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, p = at(t), n = normal(t), w = halfWidth(t);
    right.push({ x: p.x - n.x * w, y: p.y - n.y * w });
    left.push({ x: p.x + n.x * w, y: p.y + n.y * w });
  }
  // The bowl is capped by rotating the right-hand edge point a half turn about
  // the centreline end, which lands exactly on the left-hand edge point and
  // bulges outward on the way.
  const end = at(1), w = halfWidth(1);
  const v = { x: right[steps].x - end.x, y: right[steps].y - end.y };
  const cap: P[] = [];
  for (let k = 1; k < 12; k++) {
    const a = (k / 12) * Math.PI, c = Math.cos(a), s = Math.sin(a);
    cap.push({ x: end.x + v.x * c - v.y * s, y: end.y + v.x * s + v.y * c });
  }
  const ring = [...right, ...cap, ...left.reverse()];
  return "M" + fmt(ring[0]) + "L" + ring.slice(1).map(fmt).join("L") + "Z";
}

/// The shading runs across the blade, not along it: white on the convex back,
/// blue in the hollow. That single axis is what makes a flat fill read as a
/// scooped surface.
const AXIS = (() => {
  const p = at(0.72), n = normal(0.72), d = WIDTH * 1.35;
  return {
    x1: (p.x - n.x * d).toFixed(2), y1: (p.y - n.y * d).toFixed(2),
    x2: (p.x + n.x * d).toFixed(2), y2: (p.y + n.y * d).toFixed(2),
  };
})();

function gradient(id: string): string {
  return `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" ` +
    `x1="${AXIS.x1}" y1="${AXIS.y1}" x2="${AXIS.x2}" y2="${AXIS.y2}">` +
    `<stop offset="0" stop-color="#ffffff"/>` +
    `<stop offset=".46" stop-color="${PALE}"/>` +
    `<stop offset="1" stop-color="${DEEP}"/>` +
    `</linearGradient>`;
}

export const BLADE = blade();

const rotations = Array.from({ length: BLADES }, (_, i) =>
  ((i * 360) / BLADES).toFixed(3).replace(/\.?0+$/, ""));

const wheel = (id: string, indent: string) =>
  rotations.map(a =>
    `${indent}<path d="${BLADE}" fill="url(#${id})" transform="rotate(${a} ${CX} ${CY})"/>`
  ).join("\n");

const svg = (bg?: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">
  <defs>${gradient("b")}</defs>
${bg ? `  <rect width="64" height="64" rx="14" fill="${bg}"/>\n` : ""}${wheel("b", "  ")}
</svg>
`;

fs.writeFileSync(path.join(APP, "logo.svg"), svg());
fs.writeFileSync(path.join(APP, "favicon.svg"), svg(BRAND));
fs.writeFileSync(path.join(ROOT, "web", "public", "favicon.svg"), svg(BRAND));

// app/index.html is now build output, so the nav's copy of the mark lives in
// the React source and is regenerated there instead.
const brand = path.join(ROOT, "web", "src", "components", "Brand.tsx");
if (fs.existsSync(brand)) {
  const src = fs.readFileSync(brand, "utf8");
  fs.writeFileSync(brand, src
    .replace(/(export const BLADE_PATH = ")[^"]*(")/, `$1${BLADE}$2`)
    .replace(/(export const BLADES = )\d+/, `$1${BLADES}`)
    .replace(/(offset="\.46" stopColor=")#[0-9a-fA-F]{6}/, `$1${PALE}`)
    .replace(/(offset="1" stopColor=")#[0-9a-fA-F]{6}/, `$1${DEEP}`)
    .replace(/x1="[\d.]+" y1="[\d.]+" x2="[\d.]+" y2="[\d.]+"/,
      `x1="${AXIS.x1}" y1="${AXIS.y1}" x2="${AXIS.x2}" y2="${AXIS.y2}"`));
}
console.log("wrote app/logo.svg, app/favicon.svg, web/public/favicon.svg");
