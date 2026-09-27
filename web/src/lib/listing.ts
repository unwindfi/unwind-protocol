/*
 * Finding something to list, from the browser.
 *
 * People arrive with a token in mind, not a pool address, so the listing
 * page starts from a search and does the pool-hunting itself: every USD pool
 * the token has on the venues the program can read, deepest first. All three
 * sources are public, allow the site's origin, and need no server, which is
 * what lets this half of listing work on the deployed site as well as
 * locally.
 *
 * These are directories, not truth. They decide what is offered; the numbers
 * a market is built from -- mark, depth, limits -- are read from the chain by
 * `getPool` once a pool is chosen.
 */
import { QUOTE_MINTS } from "@scripts/listing-policy";

export type Dex = "raydium-clmm" | "meteora-dlmm";

export const DEX_NAME: Record<Dex, string> = {
  "raydium-clmm": "Raydium CLMM",
  "meteora-dlmm": "Meteora DLMM",
};

export interface TokenHit {
  mint: string; symbol: string; name: string; icon: string | null;
  price: number | null; liquidity: number; mcap: number | null; verified: boolean;
}

export interface PoolOption {
  dex: Dex; address: string; quote: string;
  tvl: number; volume24h: number; feePct: number;
}

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const looksLikeAddress = (s: string) => ADDRESS.test(s.trim());

async function json(url: string, signal?: AbortSignal) {
  // A venue that has not answered in twelve seconds is treated as down, so
  // the other one's pools are the list rather than a spinner.
  const r = await fetch(url, { signal: signal ?? AbortSignal.timeout(12_000) });
  if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}`);
  return r.json();
}

/// Tokens matching a ticker, a name, or a mint. Jupiter ranks by its own
/// idea of relevance; this keeps that order but floats verified tokens up,
/// because a search for a ticker returns every impersonator of it too.
export async function searchTokens(query: string, signal?: AbortSignal): Promise<TokenHit[]> {
  const q = query.trim();
  if (!q) return [];
  const rows: any[] = await json(
    `https://lite-api.jup.ag/tokens/v2/search?query=${encodeURIComponent(q)}`, signal);
  return rows
    .filter((t) => !QUOTE_MINTS[t.id])
    .map((t): TokenHit => ({
      mint: t.id, symbol: t.symbol ?? "", name: t.name ?? "", icon: t.icon ?? null,
      price: typeof t.usdPrice === "number" ? t.usdPrice : null,
      liquidity: Number(t.liquidity) || 0, mcap: typeof t.mcap === "number" ? t.mcap : null,
      verified: !!t.isVerified,
    }))
    .sort((a, b) => Number(b.verified) - Number(a.verified))
    .slice(0, 8);
}

/// Raydium concentrated pools against each stablecoin. The API filters by
/// both mints, so this is one request per quote rather than a page of
/// SOL pairs to throw away.
async function raydium(mint: string, signal?: AbortSignal): Promise<PoolOption[]> {
  const per = await Promise.all(Object.keys(QUOTE_MINTS).map(async (quote) => {
    const body = await json(
      "https://api-v3.raydium.io/pools/info/mint?" + new URLSearchParams({
        mint1: mint, mint2: quote, poolType: "concentrated",
        poolSortField: "liquidity", sortType: "desc", pageSize: "10", page: "1",
      }), signal);
    return (body?.data?.data ?? []).map((p: any): PoolOption => ({
      dex: "raydium-clmm", address: p.id, quote: QUOTE_MINTS[quote],
      tvl: Number(p.tvl) || 0, volume24h: Number(p.day?.volume) || 0,
      feePct: (Number(p.feeRate) || 0) * 100,
    }));
  }));
  return per.flat();
}

async function meteora(mint: string, signal?: AbortSignal): Promise<PoolOption[]> {
  const body = await json(
    "https://dlmm.datapi.meteora.ag/pools?" + new URLSearchParams({
      query: mint, page_size: "30", sort_by: "tvl:desc",
    }), signal);
  return (body?.data ?? [])
    .filter((p: any) => !p.is_blacklisted)
    .flatMap((p: any): PoolOption[] => {
      const x = p.token_x?.address, y = p.token_y?.address;
      const quote = x === mint ? y : y === mint ? x : null;
      if (!quote || !QUOTE_MINTS[quote]) return [];
      return [{
        dex: "meteora-dlmm", address: p.address, quote: QUOTE_MINTS[quote],
        tvl: Number(p.tvl) || 0, volume24h: Number(p.volume?.["24h"]) || 0,
        feePct: Number(p.pool_config?.base_fee_pct) || 0,
      }];
    });
}

/// The venues, asked separately. Each is cached per token for a minute, so a
/// pool list started while the pointer rests on a search result is already
/// there, or on its way, when the click lands. The directories can take ten
/// seconds on a bad minute; starting early is most of what can be done.
const SOURCES = [raydium, meteora];
const cache = new Map<string, { at: number; each: Promise<PoolOption[]>[] }>();

export function poolSources(mint: string): Promise<PoolOption[]>[] {
  const hit = cache.get(mint);
  if (hit && Date.now() - hit.at < 60_000) return hit.each;
  const each = SOURCES.map((f) => f(mint).then(
    (ps) => ps.filter((p) => p.tvl > 0),
    (e) => { cache.delete(mint); throw e; },
  ));
  // Settled here too, so a rejection nobody is waiting on yet is not reported
  // as unhandled; whoever reads the promise still sees it.
  each.forEach((p) => p.catch(() => {}));
  cache.set(mint, { at: Date.now(), each });
  return each;
}

/// Warm a token's pools ahead of the click.
export const prefetchPools = (mint: string) => { poolSources(mint); };

export const byDepth = (a: PoolOption, b: PoolOption) => b.tvl - a.tvl;

/*
 * What a backer can pay in. Each is held as itself, the way Jupiter's JLP pool
 * holds each asset in a custody of its own: nothing is swapped, and a backer's
 * share comes back out in the same mix it went in.
 */
export const PAY_TOKENS = {
  USDC: {
    mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", logo: "/logos/USDC.png",
    quick: [1_000, 5_000, 10_000],
  },
  USDT: {
    mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", logo: "/logos/USDT.svg",
    quick: [1_000, 5_000, 10_000],
  },
  SOL: { mint: "So11111111111111111111111111111111111111112", logo: "/logos/SOL.png", quick: [5, 25, 100] },
} as const;
export type PayWith = keyof typeof PAY_TOKENS;

/// USD per token, from Jupiter's price API. Only used to show what a SOL or
/// USDT amount is worth before signing; the program values it at the oracle.
export async function usdPrices(): Promise<Record<PayWith, number>> {
  const ids = Object.values(PAY_TOKENS).map((t) => t.mint).join(",");
  const body = await json(`https://lite-api.jup.ag/price/v3?ids=${ids}`);
  const of = (k: PayWith) => Number(body?.[PAY_TOKENS[k].mint]?.usdPrice) || (k === "SOL" ? 0 : 1);
  return { USDC: of("USDC"), USDT: of("USDT"), SOL: of("SOL") };
}
