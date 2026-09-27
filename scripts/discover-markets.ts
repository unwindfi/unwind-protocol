/// Resolves real xStocks markets from their live sources.
///
/// Nothing here is hand-typed: the mint, name and logo come from Jupiter's
/// token index, and the trading calendar's feed id from Pyth. A market is only
/// emitted when both halves resolve — a mint with no Pyth feed has no session
/// calendar, and this venue's whole point is pricing that difference.
import * as fs from "fs";
import * as path from "path";

const ROOT = path.join(__dirname, "..");
const JUP_SEARCH = "https://lite-api.jup.ag/tokens/v2/search";
const PYTH_META = "https://hermes.pyth.network/v2/price_feeds";

/// Candidates, most liquid first. The list is longer than what will fit so the
/// transaction-size ceiling decides the cut rather than taste.
const TICKERS = [
  "TSLA", "NVDA", "AAPL", "MSTR", "CRCL", "HOOD", "META", "GOOGL",
  "AMZN", "MSFT", "SPY", "QQQ", "COIN", "AMD", "NFLX", "PLTR",
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/// The keyless endpoints are shared with the running price loop, so a 429 here
/// is routine rather than exceptional. Wait it out instead of dropping the
/// ticker — a market missing because of a transient limit is worse than slow.
async function getJson(url: string, tries = 5) {
  let wait = 3_000;
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url);
    if (r.ok) return r.json() as any;
    if (r.status !== 429) throw new Error(`${r.status} for ${url}`);
    await sleep(wait);
    wait = Math.min(30_000, wait * 2);
  }
  throw new Error(`429 for ${url} after ${tries} tries`);
}

async function main() {
  const feeds: any[] = await getJson(`${PYTH_META}?asset_type=equity`);
  // Prefer the plain listing over the "24/7" variant: its market_hours is the
  // real exchange calendar, which is what drives the session.
  const bySymbol = new Map<string, any>();
  for (const f of feeds) {
    const a = f.attributes ?? {};
    const sym = a.display_symbol;
    if (!sym) continue;
    const is247 = /24\/7/i.test(a.description ?? "");
    if (!bySymbol.has(sym) || (is247 === false && /24\/7/i.test(bySymbol.get(sym).attributes?.description ?? "")))
      bySymbol.set(sym, f);
  }

  // Resume rather than restart: a re-run should only fetch what is missing.
  const outPath = path.join(ROOT, "scripts/markets.discovered.json");
  const out: any[] = fs.existsSync(outPath)
    ? JSON.parse(fs.readFileSync(outPath, "utf8"))
    : [];
  const have = new Set(out.map((m: any) => m.symbol.replace(/x$/, "")));

  for (const t of TICKERS) {
    if (have.has(t)) { console.log(`  ${t.padEnd(6)} already resolved`); continue; }
    const feed = bySymbol.get(t);
    if (!feed) { console.log(`  ${t.padEnd(6)} skipped — no Pyth equity feed`); continue; }

    let hits: any[];
    try {
      hits = await getJson(`${JUP_SEARCH}?query=${t}x`);
    } catch (e: any) {
      console.log(`  ${t.padEnd(6)} skipped — ${e.message}`);
      await sleep(2500);
      continue;
    }
    const tok = (hits ?? []).find(
      (h: any) => h.symbol?.toUpperCase() === `${t}X` && String(h.id).startsWith("Xs")
    );
    if (!tok) { console.log(`  ${t.padEnd(6)} skipped — no xStock mint`); await sleep(2500); continue; }

    out.push({
      symbol: tok.symbol,
      name: String(tok.name).replace(/\s*xStock$/i, ""),
      mint: tok.id,
      underlyingFeedId: feed.id,
      icon: tok.icon ?? null,
      liquidity: Number(tok.liquidity) || 0,
      schedule: feed.attributes?.schedule ?? null,
    });
    console.log(
      `  ${tok.symbol.padEnd(6)} ${tok.id}  liq $${Math.round(Number(tok.liquidity) || 0).toLocaleString()}`
    );
    // The keyless endpoints are shared and rate limited; this walk is a one-off.
    await sleep(2500);
  }

  out.sort((a, b) => b.liquidity - a.liquidity);
  fs.writeFileSync(path.join(ROOT, "scripts/markets.discovered.json"), JSON.stringify(out, null, 2));
  console.log(`\nresolved ${out.length} markets -> scripts/markets.discovered.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
