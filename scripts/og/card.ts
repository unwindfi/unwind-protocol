/*
 * Share cards: the image a link to a market shows when it is posted on X,
 * Telegram or Discord.
 *
 * One card per market, drawn from the market's live figures the moment a
 * crawler asks for it, so a link to a listing made a minute ago previews as
 * that market and not as the home page. Laid out as a token card: the
 * token's logo and name, its price and the day's move, four figures, the way
 * in, and the time the figures were read. The ground is the brand's (the
 * violet diagonal with the unwind coin, pre-rendered in bg-market.png).
 *
 * satori lays the card out from a plain element tree and resvg turns it into
 * a PNG; both are pure, so this runs anywhere the server does.
 */
import * as fs from "fs";
import * as path from "path";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";

const HERE = __dirname;
const ROOT = path.join(HERE, "../..");
const file = (name: string) => fs.readFileSync(path.join(HERE, name));
const dataUrl = (buf: Buffer, mime: string) => `data:${mime};base64,${buf.toString("base64")}`;

const FONTS = [
  { name: "IT", data: file("InterTight-500.woff"), weight: 500 as const, style: "normal" as const },
  { name: "IT", data: file("InterTight-600.woff"), weight: 600 as const, style: "normal" as const },
];
const BG = dataUrl(file("bg-market.png"), "image/png");
const MARK = dataUrl(file("mark.png"), "image/png");
/// The outlined wordmark (web/src/components/Wordmark.tsx), white.
const WORDMARK = dataUrl(file("wordmark.svg"), "image/svg+xml");
/// lucide's arrow-right: the font has no arrow glyph.
const ARROW = dataUrl(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#0b0a14" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>'), "image/svg+xml");

export interface CardMarket {
  symbol: string; name: string; price: number; changePct: number;
  maxLeverage: number; backingUsd: number; poolFillUsd?: number;
  observed: unknown; icon?: string | null; color: string; mono: string;
}

/// The same rules as the site's `price` in web/src/lib/format.ts.
export const fmtPrice = (n: number) => {
  if (!Number.isFinite(n) || n <= 0) return "–";
  const d = n >= 1000 ? 2 : n >= 1 ? 2 : n >= 0.01 ? 4 : 6;
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
};
export const fmtUsd = (n: number) =>
  n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M`
    : n >= 1e4 ? `$${(n / 1e3).toFixed(1)}K` : "$" + Math.round(n).toLocaleString("en-US");
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const fmtStamp = (d: Date) =>
  `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;

/// The token's logo as something resvg can draw: the site's own file when it
/// has one, else the token's PNG or JPEG from its metadata. WebP, SVG or a
/// failed fetch fall back to the ticker's initials on its colour, the way the
/// site draws a token with no logo.
const logos = new Map<string, string | null>();
async function logoOf(m: CardMarket): Promise<string | null> {
  if (logos.has(m.symbol)) return logos.get(m.symbol)!;
  let out: string | null = null;
  const local = path.join(ROOT, "web/public/logos", `${m.symbol}.png`);
  if (fs.existsSync(local)) out = dataUrl(fs.readFileSync(local), "image/png");
  else if (m.icon) {
    try {
      const r = await fetch(m.icon, { signal: AbortSignal.timeout(4000) });
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf[0] === 0x89 && buf[1] === 0x50) out = dataUrl(buf, "image/png");
      else if (buf[0] === 0xff && buf[1] === 0xd8) out = dataUrl(buf, "image/jpeg");
    } catch { /* drawn as initials */ }
  }
  logos.set(m.symbol, out);
  return out;
}

type El = { type: string; props: Record<string, unknown> & { children?: unknown } };
const h = (type: string, style: Record<string, unknown>, children?: unknown, extra: Record<string, unknown> = {}): El =>
  ({ type, props: { style: { display: "flex", ...style }, children, ...extra } });

const MUTE = "rgba(255,255,255,0.58)";

export async function marketCard(m: CardMarket, at = new Date()): Promise<Buffer> {
  const logo = await logoOf(m);
  const up = m.changePct >= 0;
  const stats: [string, string][] = [
    ["Max leverage", `${m.maxLeverage}x`],
    ["Backing", fmtUsd(m.backingUsd)],
    ["Per batch", fmtUsd(m.poolFillUsd ?? 0)],
    ["Price from", m.observed ? "DEX pool" : "Pyth"],
  ];
  const stat = ([k, v]: [string, string]) => h("div", { flexDirection: "column", width: 270, marginBottom: 30 }, [
    h("div", { fontSize: 22, color: MUTE, fontWeight: 500 }, k),
    h("div", { fontSize: 42, fontWeight: 600, marginTop: 6, letterSpacing: "-0.02em" }, v),
  ]);
  const tree = h("div", {
    width: 1200, height: 630, position: "relative", flexDirection: "column", color: "#fff",
    fontFamily: "IT", backgroundImage: `url(${BG})`, backgroundSize: "1200px 630px", padding: "52px 60px",
  }, [
    // Token and price.
    h("div", { justifyContent: "space-between", alignItems: "flex-start" }, [
      h("div", { alignItems: "center" }, [
        logo
          ? h("img", { width: 84, height: 84, borderRadius: 42 }, undefined, { src: logo, width: 84, height: 84 })
          : h("div", { width: 84, height: 84, borderRadius: 42, background: m.color, alignItems: "center", justifyContent: "center",
              fontSize: 30, fontWeight: 600 }, m.mono),
        h("div", { flexDirection: "column", marginLeft: 22 }, [
          h("div", { fontSize: 50, fontWeight: 600, letterSpacing: "-0.02em", lineHeight: 1 }, m.symbol),
          h("div", { fontSize: 26, color: MUTE, fontWeight: 500, marginTop: 8 }, m.name),
        ]),
      ]),
      h("div", { flexDirection: "column", alignItems: "flex-end" }, [
        h("div", { fontSize: 50, fontWeight: 600, letterSpacing: "-0.02em", lineHeight: 1 }, fmtPrice(m.price)),
        h("div", { fontSize: 28, fontWeight: 600, marginTop: 10, color: up ? "#2fc46b" : "#f04d4d" },
          `${up ? "+" : ""}${m.changePct.toFixed(2)}%`),
      ]),
    ]),
    // Four figures, and the way in beside them.
    h("div", { marginTop: 70, justifyContent: "space-between", alignItems: "center" }, [
      h("div", { flexWrap: "wrap", width: 560 }, stats.map(stat)),
      h("div", { background: "#fff", color: "#0b0a14", borderRadius: 999, padding: "22px 36px 22px 40px", fontSize: 30, fontWeight: 600,
        marginRight: 10, marginTop: -20, alignItems: "center" }, [
        `Trade ${m.symbol} on unwind`,
        h("img", { width: 30, height: 30, marginLeft: 12 }, undefined, { src: ARROW, width: 30, height: 30 }),
      ]),
    ]),
    // The lockup and when these figures were read.
    h("div", { position: "absolute", left: 60, bottom: 46, alignItems: "center" }, [
      h("img", { width: 44, height: 44 }, undefined, { src: MARK, width: 44, height: 44 }),
      h("img", { width: 128, height: 30, marginLeft: 12 }, undefined, { src: WORDMARK, width: 128, height: 30 }),
      h("div", { fontSize: 20, color: MUTE, fontWeight: 500, marginLeft: 26 }, `Devnet · ${fmtStamp(at)}`),
    ]),
  ]);
  const svg = await satori(tree as never, { width: 1200, height: 630, fonts: FONTS });
  return Buffer.from(new Resvg(svg, { fitTo: { mode: "width", value: 1200 } }).render().asPng());
}
