/// Moves the testnet's seeded pools the way real tokens move.
///
/// Nobody trades the pools `seed-devnet-pools.ts` made, so without this their
/// prices, and the markets listed on them, would sit still forever. Each one
/// shadows a real token instead: every pass reads the real token's price on
/// mainnet (Jupiter) and swaps in the devnet pool. A test copy of a real token
/// is held at the real price, so its chart can carry the real token's history
/// from its mainnet pool; an invented token moves by the same percentage as
/// the real one it follows, from its own made-up price.
///
/// The swaps are ordinary DLMM swaps, so everything downstream (the observed
/// mark, its velocity clamp, depth, budgets) sees exactly what it would see if
/// the flow were organic. The authority mints both sides of every pool, so
/// whatever a swap needs it mints first; nothing here can run out.
import DLMM, { StrategyType, deriveBinArrayBitmapExtension } from "@meteora-ag/dlmm";
import { BN } from "@coral-xyz/anchor";
import {
  Connection, Keypair, PublicKey, SYSVAR_RENT_PUBKEY, SystemProgram, sendAndConfirmTransaction, Transaction,
} from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";

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
    // Added 2026-10-04 from Jupiter's top traded and top organic lists:
    // verified, still trading, and none of the stablecoins.
    PUMP: ["Pump", "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn"],
    SPCXx: ["SpaceX xStock", "Xs3oZwbHvqis4NYcf4YKWmEia2eC84wSiVrcYcTqpH8"],
    STONK: ["Stonk", "6GmAFSYs4gk3FDao5FzzySQpPZaWsa4rUJHacpMpUNgx"],
    ZEC: ["Zcash", "A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS"],
    cbBTC: ["Coinbase Wrapped BTC", "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij"],
    NVDAx: ["NVIDIA xStock", "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh"],
    HYPE: ["Hyperliquid", "98sMhvDwXj1RQi5c5Mndm3vPe9cBqPrbLaufMXFNMh5g"],
    USELESS: ["Useless Coin", "Dz9mQ9NzkBcCsuGPFJ3r1bS4wgqKMHBPiVuniW8Mbonk"],
    BP: ["BP", "BPxxfRCXkUVhig4HS1Lh7kZqV6SPJhzfEk4x6fVBjPCy"],
    wNEAR: ["NEAR (Wormhole)", "3ZLekZYq2qkZiSpnSvabjit34tUkjSwD1JFuW9as9wBG"],
    ETH: ["Ether (Wormhole)", "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs"],
    CARDS: ["Collector Crypt", "CARDSccUMFKoPRZxt5vt3ksUbxEFEcnZ3H2pd3dKxYjp"],
    ANSEM: ["Ansem", "9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump"],
    MET: ["Meteora", "METvsvVRapdj9cFLzq4Tr43xK4tAjQfwX76z3n6mWQL"],
    JLP: ["Jupiter Perps LP", "27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4"],
    CATE: ["Cate", "Ai66LHZG9MCzg1WKdawwqduVAXpNDUuV8M3uyq5ppump"],
    JitoSOL: ["Jito Staked SOL", "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn"],
    GRASS: ["Grass", "Grass7B4RdKfBCjTKgSqnXkqjwiGvQyFbuSCUJr3XXjs"],
    ORE: ["Ore", "oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp"],
    GLDx: ["Gold xStock", "Xsv9hRk1z5ystj9MhnA7Lq4vjSsLwzL2nxrwmwtD3re"],
    ANTFUN: ["AntFun", "CWZ6BsdnjkDVTGkmL6bGbJXXig6ceef12KvyGQW14cMt"],
    ZCAT: ["ZCAT", "HcRLc9VDgjLeK154xDawfb1dmVJ98DoSqcwTHGqiDeJR"],
    KMNO: ["Kamino", "KMNo3nJsBXfcpJTVhZcXLW7RmTwTt4GVFE7suUBo9sS"],
    GEOD: ["Geodnet", "7JA5eZdCzztSfQbJvS8aVVxMFfd81Rs9VvwnocV1mKHu"],
    NOS: ["Nosana", "nosXBVoaCTtYdLvKY6Csb4AC8JCdQKKAaWYtx2ZMoo7"],
    MPLX: ["Metaplex", "METAewgxyPbgwsseH8T16a39CQ5VyVxZi9zXiDPY18m"],
    neet: ["neet", "Ce2gx9KGXJ6C9Mp5b5x1sn9Mg87JwEbrQby4Zqo3pump"],
    DBR: ["deBridge", "DBRiDgJAMsM95moTzJs7M9LnkGErpbv9v6CUR1DXnUu5"],
    BOME: ["Book of Meme", "ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82"],
    TSLAx: ["Tesla xStock", "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB"],
    AAPLx: ["Apple xStock", "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp"],
    ZBCN: ["Zebec Network", "ZBCNpuD7YMXzTHB2fhGkGi78MNsHGLRXUhRewNRm9RU"],
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

/// `real` is set on a copy made on request (`seedPool` via the server's
/// /api/devnet-copy): the mainnet mint it follows, and `sideUsd` the depth it
/// was laid with. The seeded set is looked up in SHADOWS instead.
export type Seeded = { symbol: string; name?: string; mint: string; pair: string; real?: string; sideUsd?: number };

/// The mainnet mint a seeded pool follows, if any.
export const realMintOf = (s: Seeded) => s.real ?? SHADOWS[s.symbol]?.mint;
/// A copy is held at the real price; an invented token only follows its moves.
const isCopy = (s: Seeded) => !!s.real || SHADOWS[s.symbol]?.symbol === s.symbol;
type Anchor = { real: number; pool: number };

export function makeFlow(conn: Connection, authority: Keypair, usdc: PublicKey, seeded: Seeded[]) {
  const anchors = new Map<string, Anchor>();

  return async function flow() {
    // Read each pass: copies made on request join `seeded` while this runs.
    const pools = seeded.filter((s) => realMintOf(s));
    const ids = [...new Set(pools.map((s) => realMintOf(s)!))].join(",");
    const r = await fetch(`${JUP_PRICE}?ids=${ids}`, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`jupiter price ${r.status}`);
    const real = (await r.json()) as Record<string, { usdPrice: number }>;

    for (const s of pools) {
      const realPrice = real[realMintOf(s)!]?.usdPrice;
      if (!realPrice) continue;
      try {
        try {
          await follow(s, realPrice);
        } catch (e: any) {
          // A pool whose price has walked past the range its own account
          // tracks needs a bitmap extension before it can be swapped in; the
          // ORCA copy got there and every pass failed. Made once, then retried.
          if (!/BitmapExtensionAccountIsNotProvided/.test(String(e?.message ?? e) + JSON.stringify(e?.logs ?? ""))) throw e;
          await addBitmapExtension(new PublicKey(s.pair));
          console.log(`flow ${s.symbol}: added its bin array bitmap extension`);
          await follow(s, realPrice);
        }
      } catch (e: any) {
        // One pool that cannot move must not hold the others still.
        console.warn(`flow ${s.symbol}: ${e?.message ?? e}`);
      }
    }
  };

  async function addBitmapExtension(pair: PublicKey) {
    const dlmm = await DLMM.create(conn, pair);
    const [ext] = deriveBinArrayBitmapExtension(pair, dlmm.program.programId);
    if (await conn.getAccountInfo(ext)) return;
    const ix = await (dlmm.program.methods as any).initializeBinArrayBitmapExtension()
      .accounts({
        lbPair: pair, binArrayBitmapExtension: ext, funder: authority.publicKey,
        systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
      })
      .instruction();
    await sendAndConfirmTransaction(conn, new Transaction().add(ix), [authority]);
  }

  async function follow(s: Seeded, realPrice: number) {
    const dlmm = await DLMM.create(conn, new PublicKey(s.pair));
    const now = Number((await dlmm.getActiveBin()).pricePerToken);
    // A copy of a real token is held at the real price itself: its chart
    // draws the real token's history from its mainnet pool, and a pool at its
    // own offset would trade at a level that history never shows. One that
    // drifted is walked back in a pass. An invented token keeps its own price
    // and follows the real one's moves from where it was when this started.
    let target = realPrice;
    if (!isCopy(s)) {
      let a = anchors.get(s.symbol);
      if (!a) { a = { real: realPrice, pool: now }; anchors.set(s.symbol, a); }
      target = a.pool * (realPrice / a.real);
    }

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
      Number((await dlmm.getActiveBin()).pricePerToken), s.sideUsd);
    console.log(`flow ${s.symbol}: re-laid liquidity around bin ${active}`);
  }
}

/// The only bin step devnet has a preset for.
const BIN_STEP = 10;

/// Mints a test token and opens a DLMM pool for it against `usdc` at
/// `price`, with `sideUsd` of liquidity either side. Used by the seeding
/// script and by the server's copies made on request.
export async function seedPool(
  conn: Connection, authority: Keypair, usdc: PublicKey,
  t: { price: number; decimals: number; sideUsd?: number },
) {
  const presets = await DLMM.getAllPresetParameters(conn);
  // Devnet carries only the newer preset accounts.
  const preset = presets.presetParameter2.find((p) => p.account.binStep === BIN_STEP);
  if (!preset) throw new Error(`no DLMM preset with bin step ${BIN_STEP} on this cluster`);

  const mint = await createMint(conn, authority, authority.publicKey, null, t.decimals);
  // DLMM prices in base units of Y per base unit of X, so the dollar price
  // is scaled by the difference in decimals.
  const perLamport = t.price * 10 ** (6 - t.decimals);
  const activeId = DLMM.getBinIdFromPrice(perLamport, BIN_STEP, true);
  const create = await DLMM.createLbPair2(
    conn, authority.publicKey, mint, usdc, preset.publicKey, new BN(activeId));
  await sendAndConfirmTransaction(conn, create, [authority]);

  const pair = await DLMM.getPairPubkeyIfExists(
    conn, mint, usdc, new BN(BIN_STEP), new BN(preset.account.baseFactor),
    new BN(preset.account.baseFeePowerFactor ?? 0)) ?? await findPair(conn, mint, usdc);
  // The pair is read back before the cluster has it everywhere otherwise.
  await new Promise((r) => setTimeout(r, 2_000));
  const dlmm = await DLMM.create(conn, pair);
  const position = await layLiquidity(conn, authority, dlmm, mint.toBase58(), usdc, activeId, t.price, t.sideUsd);
  return { mint, pair, position };
}

/// The pair just created, found by its two mints when the address derivation
/// above does not match this SDK version's seeds.
async function findPair(conn: Connection, x: PublicKey, y: PublicKey): Promise<PublicKey> {
  const pairs = await DLMM.getLbPairs(conn);
  const hit = pairs.find((p) => p.account.tokenXMint.equals(x) && p.account.tokenYMint.equals(y));
  if (!hit) throw new Error(`pair for ${x.toBase58()} not found`);
  return hit.publicKey;
}

/// One position of `SIDE_USD` each side, `HALF_WIDTH` bins either side of
/// `active`, minted fresh. Shared with the seeding script's shape.
export async function layLiquidity(
  conn: Connection, authority: Keypair, dlmm: DLMM, mint: string, usdc: PublicKey,
  active: number, priceUsd: number, sideUsd: number = SIDE_USD,
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
