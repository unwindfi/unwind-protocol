/// Moves the testnet's seeded pools the way real tokens move.
///
/// Nobody trades the pools `seed-devnet-pools.ts` made, so without this their
/// prices, and the markets listed on them, would sit still forever. Each one
/// shadows a real token instead: every pass reads the real token's price on
/// mainnet (Jupiter) and swaps in the devnet pool until the pool has moved by
/// the same percentage since this process started. The charts get real
/// volatility and real trends, while the tokens stay plainly made up.
///
/// The swaps are ordinary DLMM swaps, so everything downstream (the observed
/// mark, its velocity clamp, depth, budgets) sees exactly what it would see if
/// the flow were organic. The authority mints both sides of every pool, so
/// whatever a swap needs it mints first; nothing here can run out.
import DLMM, { StrategyType } from "@meteora-ag/dlmm";
import { BN } from "@coral-xyz/anchor";
import {
  Connection, Keypair, PublicKey, sendAndConfirmTransaction, Transaction,
} from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";

/// The real token each seeded one follows, by mainnet mint.
///
/// WIND, KITE and YAK are invented and follow a real token's moves. The rest
/// are test copies of popular Solana tokens under their own tickers: seeded at
/// the real price and following it, so the testnet's markets look like the
/// ones people would actually trade. Their mints are devnet test tokens and
/// worth nothing.
export const SHADOWS: Record<string, { symbol: string; name?: string; mint: string }> = {
  WIND: { symbol: "BONK", mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263" },
  KITE: { symbol: "JUP", mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN" },
  YAK: { symbol: "WIF", mint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm" },
  ...popular({
    SOL: ["Solana", "So11111111111111111111111111111111111111112"],
    JUP: ["Jupiter", "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN"],
    BONK: ["Bonk", "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"],
    WIF: ["dogwifhat", "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm"],
    JTO: ["Jito", "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL"],
    PYTH: ["Pyth Network", "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3"],
    RAY: ["Raydium", "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R"],
    TRUMP: ["Official Trump", "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN"],
    PENGU: ["Pudgy Penguins", "2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv"],
    FARTCOIN: ["Fartcoin", "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump"],
    POPCAT: ["Popcat", "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr"],
    RENDER: ["Render", "rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof"],
    HNT: ["Helium", "hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux"],
    ORCA: ["Orca", "orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE"],
    DRIFT: ["Drift", "DriFtupJYLTosbwoN8koMbEYSx54aFAVLddWsbksjwg7"],
  }),
};
function popular(t: Record<string, [string, string]>) {
  return Object.fromEntries(Object.entries(t).map(([symbol, [name, mint]]) => [symbol, { symbol, name, mint }]));
}
/// The copies of real tokens, as opposed to the invented three.
export const POPULAR = Object.keys(SHADOWS).filter((k) => SHADOWS[k].symbol === k);
export const JUP_PRICE = "https://lite-api.jup.ag/price/v3";

/// Moves smaller than a bin are left alone: the pool cannot show them anyway.
const DEADBAND = 0.001;
/// Liquidity is re-laid around the price once it gets this close (in bins)
/// to the edge of every position, before the pool runs out of depth.
const EDGE_BINS = 5;
/// Each side of a re-laid position, in dollars, and its half-width in bins:
/// the same shape the seeding script lays.
const SIDE_USD = 180_000;
const HALF_WIDTH = 30;

type Seeded = { symbol: string; mint: string; pair: string };
type Anchor = { real: number; pool: number };

export function makeFlow(conn: Connection, authority: Keypair, usdc: PublicKey, seeded: Seeded[]) {
  const anchors = new Map<string, Anchor>();
  const pools = seeded.filter((s) => SHADOWS[s.symbol]);

  return async function flow() {
    const ids = pools.map((s) => SHADOWS[s.symbol].mint).join(",");
    const r = await fetch(`${JUP_PRICE}?ids=${ids}`, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`jupiter price ${r.status}`);
    const real = (await r.json()) as Record<string, { usdPrice: number }>;

    for (const s of pools) {
      const realPrice = real[SHADOWS[s.symbol].mint]?.usdPrice;
      if (!realPrice) continue;
      try {
        await follow(s, realPrice);
      } catch (e: any) {
        // One pool that cannot move must not hold the others still.
        console.warn(`flow ${s.symbol}: ${e?.message ?? e}`);
      }
    }
  };

  async function follow(s: Seeded, realPrice: number) {
    const dlmm = await DLMM.create(conn, new PublicKey(s.pair));
    const now = Number((await dlmm.getActiveBin()).pricePerToken);
    // Anchored at the first pass, so a restart re-bases rather than jumping
    // the pool to wherever the real token has gone since.
    let a = anchors.get(s.symbol);
    if (!a) { a = { real: realPrice, pool: now }; anchors.set(s.symbol, a); }
    const target = a.pool * (realPrice / a.real);

    if (Math.abs(target / now - 1) > DEADBAND) {
      await swapTo(dlmm, s, target, target > now);
      await dlmm.refetchStates();
    }
    await keepLiquidityAround(dlmm, s);
  }

  /// Swaps until the pool's price reaches `target`, sized by searching the
  /// SDK's own quote rather than guessing at the bins' liquidity.
  async function swapTo(dlmm: DLMM, s: Seeded, target: number, up: boolean) {
    // Buying the token (paying USDC) raises its price; selling lowers it.
    const swapForY = !up;
    const inMint = up ? usdc : new PublicKey(s.mint);
    const outMint = up ? new PublicKey(s.mint) : usdc;
    const binArrays = await dlmm.getBinArrayForSwap(swapForY, 6);
    const targetLamport = Number(dlmm.toPricePerLamport(target));
    const reached = (end: number) => (up ? end >= targetLamport : end <= targetLamport);

    // Upper bound for the search: a whole side's worth of the input token.
    const inDecimals = up ? 6 : dlmm.tokenX.mint.decimals;
    const inPrice = up ? 1 : target;
    let lo = 0n;
    let hi = BigInt(Math.ceil((SIDE_USD / inPrice) * 10 ** inDecimals));
    let best: ReturnType<DLMM["swapQuote"]> | null = null;
    for (let i = 0; i < 24 && hi - lo > 1n; i++) {
      const mid = (lo + hi) / 2n;
      const q = dlmm.swapQuote(new BN(mid.toString()), swapForY, new BN(100), binArrays, true);
      if (reached(Number(q.endPrice.toString()))) { hi = mid; best = q; } else lo = mid;
    }
    const amount = best ? hi : lo;
    if (amount === 0n) return;
    const quote = best ?? dlmm.swapQuote(new BN(amount.toString()), swapForY, new BN(100), binArrays, true);

    await mintTo(conn, authority, inMint,
      (await getOrCreateAssociatedTokenAccount(conn, authority, inMint, authority.publicKey)).address,
      authority, amount);
    await getOrCreateAssociatedTokenAccount(conn, authority, outMint, authority.publicKey);
    const tx = await dlmm.swap({
      inToken: inMint, outToken: outMint, inAmount: new BN(amount.toString()),
      minOutAmount: quote.minOutAmount, lbPair: dlmm.pubkey, user: authority.publicKey,
      binArraysPubkey: quote.binArraysPubkey,
    });
    await sendAndConfirmTransaction(conn, tx, [authority]);
  }

  /// Lays a fresh position around the price when it nears the edge of every
  /// existing one. Old positions stay: liquidity left behind is depth the
  /// price finds again if it comes back.
  async function keepLiquidityAround(dlmm: DLMM, s: Seeded) {
    const active = (await dlmm.getActiveBin()).binId;
    const { userPositions } = await dlmm.getPositionsByUserAndLbPair(authority.publicKey);
    const covered = userPositions.some((p) =>
      active >= p.positionData.lowerBinId + EDGE_BINS && active <= p.positionData.upperBinId - EDGE_BINS);
    if (covered) return;
    await layLiquidity(conn, authority, dlmm, s.mint, usdc, active,
      Number((await dlmm.getActiveBin()).pricePerToken));
    console.log(`flow ${s.symbol}: re-laid liquidity around bin ${active}`);
  }
}

/// One position of `SIDE_USD` each side, `HALF_WIDTH` bins either side of
/// `active`, minted fresh. Shared with the seeding script's shape.
export async function layLiquidity(
  conn: Connection, authority: Keypair, dlmm: DLMM, mint: string, usdc: PublicKey,
  active: number, priceUsd: number, sideUsd = SIDE_USD,
) {
  const base = new PublicKey(mint);
  const decimals = dlmm.tokenX.mint.decimals;
  const x = BigInt(Math.ceil(sideUsd / priceUsd)) * 10n ** BigInt(decimals);
  const y = BigInt(sideUsd) * 1_000_000n;
  await mintTo(conn, authority, base,
    (await getOrCreateAssociatedTokenAccount(conn, authority, base, authority.publicKey)).address, authority, x);
  await mintTo(conn, authority, usdc,
    (await getOrCreateAssociatedTokenAccount(conn, authority, usdc, authority.publicKey)).address, authority, y);
  const position = Keypair.generate();
  const tx = await dlmm.initializePositionAndAddLiquidityByStrategy({
    positionPubKey: position.publicKey, user: authority.publicKey,
    totalXAmount: new BN(x.toString()), totalYAmount: new BN(y.toString()),
    strategy: { minBinId: active - HALF_WIDTH, maxBinId: active + HALF_WIDTH, strategyType: StrategyType.Spot },
    slippage: 1,
  });
  await sendAndConfirmTransaction(conn, tx as Transaction, [authority, position]);
  return position.publicKey;
}
