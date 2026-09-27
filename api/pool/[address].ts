/*
 * GET /api/pool/:address -- a pool, as the market it would list as.
 *
 * The same answer the local server gives at the same path, for the deployed
 * site, which has no chain of its own. It reads mainnet directly and runs the
 * readers the program runs, so the mark, depth and limits on the preview are
 * the ones a listing would get -- only the signing is missing, and the page
 * says so.
 *
 * Read-only and unauthenticated on purpose: everything here is public chain
 * state, and the listing page is useless if it has to ask who you are before
 * it can tell you what a pool is worth.
 */
import {
  METEORA_DLMM_ID, RAYDIUM_CLMM_ID, binArrayAddress, binArrayIndex, clmmDepth, clmmPrice,
  clmmSeedPrice,
  decodeBinArray, decodeClmm, decodeDlmmPair, dlmmBinsNeeded, dlmmDepth, dlmmPrice,
  mintDecimals, type Bin,
} from "../../scripts/pools";
import {
  BACKER_FEE_SHARE_BPS, MIN_OBSERVATIONS, MIN_OBSERVATION_WINDOW_SEC, QUOTE_MINTS, SEED_MAX_GAP_BPS,
  listingLimits, unitExpFor, unitLabel,
} from "../../scripts/listing-policy";

import { forward } from "../_forward";

const RPC = process.env.MAINNET_RPC_URL || "https://api.mainnet-beta.solana.com";
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

type Account = { owner: string; data: Uint8Array } | null;

async function accounts(keys: string[]): Promise<Account[]> {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "getMultipleAccounts",
      params: [keys, { encoding: "base64", commitment: "confirmed" }],
    }),
  });
  const body = await r.json() as any;
  if (!r.ok || body.error) throw new Error("the chain did not answer; try again in a moment");
  return body.result.value.map((v: any) =>
    v ? { owner: v.owner, data: Uint8Array.from(atob(v.data[0]), (c) => c.charCodeAt(0)) } : null);
}

/// What the token calls itself. Jupiter's index rather than the metadata
/// account, because it is one request and it is what every wallet shows.
async function tokenName(mint: string) {
  try {
    const r = await fetch(`https://lite-api.jup.ag/tokens/v2/search?query=${mint}`);
    const hit = ((await r.json()) as any[]).find((t) => t.id === mint);
    if (hit) return { symbol: String(hit.symbol), name: String(hit.name), icon: hit.icon ?? null };
  } catch { /* fall through to the address */ }
  return { symbol: mint.slice(0, 4), name: mint.slice(0, 4), icon: null };
}

const quoteSide = (a: string, b: string) => {
  if (QUOTE_MINTS[a]) return true;
  if (QUOTE_MINTS[b]) return false;
  throw new Error("neither side of that pool is USDC or USDT, so it cannot price a USD market");
};

async function read(address: string) {
  const [pool] = await accounts([address]);
  if (!pool) throw new Error("no account at that address");

  if (pool.owner === RAYDIUM_CLMM_ID) {
    const p = decodeClmm(pool.data);
    const quoteIsToken0 = quoteSide(p.mint0, p.mint1);
    // Priced per billion first: under a micro-dollar a single token reads as
    // zero at six decimals, and the unit has to be chosen from a real figure.
    const price = Number(clmmPrice(p, quoteIsToken0, 9)) / 1e15;
    const unitExp = unitExpFor(price);
    // The pool's own history, which decides whether a market on it opens at
    // listing or after fifteen minutes of watching.
    const [ring] = await accounts([p.observationKey]);
    const seed = clmmSeedPrice(p, address, ring?.data ?? null, quoteIsToken0, unitExp,
      MIN_OBSERVATION_WINDOW_SEC, BigInt(SEED_MAX_GAP_BPS), Math.floor(Date.now() / 1000));
    return {
      dex: "raydium-clmm" as const, quoteIsToken0,
      base: quoteIsToken0 ? p.mint1 : p.mint0, quote: quoteIsToken0 ? p.mint0 : p.mint1,
      price, unitExp,
      unitPrice: Number(clmmPrice(p, quoteIsToken0, unitExp)) / 1e6,
      depthUsd: Number(clmmDepth(p, quoteIsToken0)) / 1e6,
      opensAtListing: seed !== null,
    };
  }

  if (pool.owner === METEORA_DLMM_ID) {
    const p = decodeDlmmPair(pool.data);
    const quoteIsX = quoteSide(p.mintX, p.mintY);
    const ids = dlmmBinsNeeded(p, quoteIsX);
    const indexes = [...new Set(ids.map(binArrayIndex))];
    const arrays = await Promise.all(indexes.map((i) => binArrayAddress(address, i)));
    const [mx, my, ...found] = await accounts([p.mintX, p.mintY, ...arrays]);
    if (!mx || !my) throw new Error("could not read the pool's mints");
    const bins = new Map<number, Bin>();
    for (const a of found) {
      if (a?.owner === METEORA_DLMM_ID) for (const [id, b] of decodeBinArray(a.data, address)) bins.set(id, b);
    }
    const [dx, dy] = [mintDecimals(mx.data), mintDecimals(my.data)];
    const price = Number(dlmmPrice(p, bins, dx, dy, quoteIsX, 9)) / 1e15;
    const unitExp = unitExpFor(price);
    return {
      dex: "meteora-dlmm" as const, quoteIsToken0: quoteIsX,
      base: quoteIsX ? p.mintY : p.mintX, quote: quoteIsX ? p.mintX : p.mintY,
      price, unitExp,
      unitPrice: Number(dlmmPrice(p, bins, dx, dy, quoteIsX, unitExp)) / 1e6,
      depthUsd: Number(dlmmDepth(p, bins, dx, dy, quoteIsX)) / 1e6,
    };
  }

  throw new Error("that is not a Raydium CLMM or Meteora DLMM pool");
}

export async function GET(req: Request) {
  // With a testnet connected, it answers: it previews pools on its own chain,
  // which a tester can actually list, and hands anything else back to this
  // same reader for mainnet. Unset on the testnet server itself, which calls
  // this function directly, so the two never loop.
  const testnet = await forward(req);
  if (testnet) return testnet;
  const address = new URL(req.url).pathname.split("/").pop() ?? "";
  if (!ADDRESS.test(address)) {
    return Response.json({ error: "That is not a Solana address." }, { status: 400 });
  }
  try {
    const p = await read(address);
    const meta = await tokenName(p.base);
    const clean = meta.symbol.replace(/[^A-Za-z0-9._-]/g, "") || p.base.slice(0, 4);
    const limits = listingLimits(p.depthUsd);
    return Response.json({
      address, ...p,
      symbol: (unitLabel(p.unitExp) + clean).slice(0, 16),
      name: meta.name, icon: meta.icon,
      unitLabel: unitLabel(p.unitExp),
      budgetUsd: p.depthUsd,
      maxOiUsd: limits.maxOiUsd, minOiUsd: limits.minOiUsd, maxLeverage: limits.maxLeverage,
      depthLeverage: limits.depthLeverage,
      // The venue's mark keeper prices a new market from its first push, so
      // every listing opens at once, whatever history its pool has.
      opensAtListing: true,
      seasonSec: 0,
      readingsNeeded: MIN_OBSERVATIONS,
      backerFeeShareBps: BACKER_FEE_SHARE_BPS,
      /// Read from mainnet by this function, not listed from it: the page
      /// uses this to offer the preview and hold back the signature.
      readOnly: true,
    }, { headers: { "cache-control": "public, s-maxage=10, stale-while-revalidate=30" } });
  } catch (e: any) {
    return Response.json({ error: String(e?.message ?? e) }, { status: 400 });
  }
}
