/// Turns discovered markets into `scripts/markets.ts` and downloads their logos.
///
/// The cut is decided by transaction size, not taste. `add_liquidity` must see
/// every market so the pool's liability is priced in full, and each market
/// costs two account slots — the market and its price update — in one legacy
/// transaction. Measured, not estimated: twelve markets serialises to 1482
/// bytes against Solana's 1232 limit, and each market is 66 bytes of that, so
/// eight would be what fits (1482 - 4*66 = 1218) on a legacy transaction.
///
/// The liquidity instructions now go through an Address Lookup Table, which
/// replaces each 32-byte key with a 1-byte index and takes the per-market cost
/// from 66 bytes to 4. Size stops binding; the 64-account-lock cap binds
/// instead, at roughly 27 markets. See scripts/alt.ts.
import * as fs from "fs";
import * as path from "path";

const ROOT = path.join(__dirname, "..");
const PYTH_META = "https://hermes.pyth.network/v2/price_feeds";
/// With the lookup table in place, transaction *size* is no longer binding —
/// Solana's 64-account-lock cap is, which leaves room for about 27 markets.
/// Every market that resolves cleanly is included.
export const MAX_MARKETS = 27;
/// A market with no depth behind it is a worse use of a slot than none at all:
/// the quote is weak and the pool would be the only real counterparty.
const MIN_LIQUIDITY_USD = 50_000;

/// Risk by class rather than per name: an index ETF carries far less
/// single-name risk than a high-beta single stock, and the maintenance margin
/// must stay below the initial margin the leverage cap implies.
const RISK: Record<string, { lev: number; mm: number; conf: number }> = {
  ETF: { lev: 200_000, mm: 250, conf: 200 },
  MEGA: { lev: 100_000, mm: 500, conf: 300 },
  // High-beta names carry a persistent premium or discount to the last print,
  // so their halt threshold has to clear it or they never quote at all.
  HIGH: { lev: 50_000, mm: 800, conf: 700 },
};
const ETFS = new Set(["SPYx", "QQQx"]);
const MEGA = new Set(["AAPLx", "MSFTx", "GOOGLx", "AMZNx", "METAx", "NVDAx"]);
const classOf = (s: string) => (ETFS.has(s) ? "ETF" : MEGA.has(s) ? "MEGA" : "HIGH");

/// Deterministic fallback tint. Only shows if a logo fails to load, so it is
/// derived from the symbol rather than guessing at brand colours.
function tint(symbol: string): string {
  let h = 0;
  for (const c of symbol) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 42% 42%)`;
}

async function main() {
  const discovered = JSON.parse(
    fs.readFileSync(path.join(ROOT, "scripts/markets.discovered.json"), "utf8"));

  const crypto = (await (await fetch(`${PYTH_META}?asset_type=crypto`)).json()) as any[];
  const byName = new Map<string, string>();
  for (const f of crypto) {
    const sym = f.attributes?.symbol;
    if (sym) byName.set(sym, f.id);
  }

  const kept: any[] = [];
  for (const m of discovered) {
    const base = m.symbol.replace(/x$/, "");
    const feedId = byName.get(`Crypto.${base.toUpperCase()}X/USD`);
    if (!feedId) { console.log(`  ${m.symbol.padEnd(7)} dropped — no Crypto.${base}X/USD feed`); continue; }
    kept.push({ ...m, feedId });
  }
  // Unknown liquidity sorts last among the kept rather than being dropped —
  // absence of a reading is not a reading of zero.
  const deep = kept.filter((m) => m.liquidity == null || m.liquidity >= MIN_LIQUIDITY_USD);
  const thin = kept.filter((m) => m.liquidity != null && m.liquidity < MIN_LIQUIDITY_USD);
  deep.sort((a, b) => (b.liquidity ?? -1) - (a.liquidity ?? -1));
  const chosen = deep.slice(0, MAX_MARKETS);
  if (thin.length) {
    console.log(`  below $${MIN_LIQUIDITY_USD.toLocaleString()} liquidity, skipped: ` +
      thin.map((m) => `${m.symbol} ($${Math.round(m.liquidity).toLocaleString()})`).join(", "));
  }

  fs.mkdirSync(path.join(ROOT, "app/logos"), { recursive: true });
  for (const m of chosen) {
    if (!m.icon) continue;
    try {
      const r = await fetch(m.icon);
      if (!r.ok) throw new Error(String(r.status));
      const buf = Buffer.from(await r.arrayBuffer());
      fs.writeFileSync(path.join(ROOT, `app/logos/${m.symbol}.png`), buf);
    } catch (e: any) {
      console.log(`  ${m.symbol.padEnd(7)} logo failed — ${e.message}`);
    }
  }

  const body = chosen.map((m) => {
    const r = RISK[classOf(m.symbol)];
    return `  {
    symbol: ${JSON.stringify(m.symbol)}, name: ${JSON.stringify(m.name)},
    mint: ${JSON.stringify(m.mint)},
    feedId:
      ${JSON.stringify(m.feedId)},
    underlyingFeedId:
      ${JSON.stringify(m.underlyingFeedId)},
    maxLeverageBps: ${r.lev.toLocaleString("en-US").replace(/,/g, "_")}, maintenanceMarginBps: ${r.mm},
    maxConfBps: ${r.conf},
    color: ${JSON.stringify(tint(m.symbol))}, mono: ${JSON.stringify(m.symbol[0])},
  },`;
  }).join("\n");

  const src = fs.readFileSync(path.join(ROOT, "scripts/markets.ts"), "utf8");
  const next = src.replace(
    /export const MARKETS: MarketDef\[\] = \[[\s\S]*?\n\];/,
    `export const MARKETS: MarketDef[] = [\n${body}\n];`
  );
  fs.writeFileSync(path.join(ROOT, "scripts/markets.ts"), next);

  console.log(`\n${chosen.length} markets written (of ${deep.length} deep enough):`);
  for (const m of chosen) {
    console.log(`  ${m.symbol.padEnd(7)} ${classOf(m.symbol).padEnd(4)} liq ${m.liquidity == null ? "unknown" : "$" + Math.round(m.liquidity).toLocaleString()}`);
  }
  if (deep.length > MAX_MARKETS) {
    console.log(`\ndropped for transaction size: ${deep.slice(MAX_MARKETS).map((m) => m.symbol).join(", ")}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
