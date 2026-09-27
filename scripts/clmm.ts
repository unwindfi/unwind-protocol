/// Reading the pools a market can be listed against, from the local server.
///
/// The arithmetic is not here. It lives in `pools.ts`, which mirrors
/// `programs/unwind/src/amm.rs` line for line and is shared with the
/// deployed site's preview function, so the local server, the preview and the
/// program all compute a pool's mark and depth with one set of truncations.
/// This file is the part that needs a `Connection`: fetching the accounts
/// those readers take, and the bin arrays a DLMM observation has to be handed
/// on every crank.
///
/// The name is historical. It read Raydium alone until Meteora's liquidity
/// book was added as a second source.
import { Connection, PublicKey } from "@solana/web3.js";
import {
  Bin, Dex, METEORA_DLMM_ID, RAYDIUM_CLMM_ID, binArrayIndex, clmmDepth, clmmPrice, clmmSeedPrice,
  decodeBinArray, decodeClmm, decodeDlmmPair, dlmmBinsNeeded, dlmmDepth, dlmmPrice, mintDecimals,
} from "./pools";
import {
  MIN_OBSERVATION_WINDOW_SEC, QUOTE_MINTS, SEED_MAX_GAP_BPS, unitExpFor,
} from "./listing-policy";

export const RAYDIUM_CLMM = new PublicKey(RAYDIUM_CLMM_ID);
export const METEORA_DLMM = new PublicKey(METEORA_DLMM_ID);

/// Stablecoin mints a pool may be quoted in, beyond the one this deployment
/// settles in.
///
/// A local validator runs a cloned mainnet pool against a locally minted USDC,
/// so the pool's stablecoin side is mainnet's mint and the perp's is not the
/// same account at all. Recognising the canonical mints is what lets the same
/// listing path be exercised locally as on mainnet; it decides only which side
/// of the pool is the quote, never what anything settles in.
export const KNOWN_QUOTE_MINTS = Object.keys(QUOTE_MINTS).map((m) => new PublicKey(m));

/// The bin array account holding array `index` of `pair`.
export function binArrayPda(pair: PublicKey, index: number): PublicKey {
  const le = Buffer.alloc(8);
  le.writeBigInt64LE(BigInt(index));
  return PublicKey.findProgramAddressSync(
    [Buffer.from("bin_array"), pair.toBuffer(), le], METEORA_DLMM)[0];
}

/// The bin arrays that exist for `pair` among those covering `ids`, plus the
/// arrays either side of the active one.
///
/// The neighbours are there because the pair can move between this read and
/// the transaction landing. An active bin that crossed into an array the
/// crank did not pass is a failed observation, and a failed observation is a
/// reading the mark does not get; ten more kilobytes of read-only account is
/// cheaper than that. Arrays that were never initialised are left out,
/// because the program refuses an account the DLMM program does not own, and
/// a missing array only ever reads as less depth.
async function existingArrays(conn: Connection, pair: PublicKey, ids: number[]) {
  const active = binArrayIndex(ids[0]);
  const indexes = [...new Set([...ids.map(binArrayIndex), active - 1, active + 1])];
  const keys = indexes.map((i) => binArrayPda(pair, i));
  const infos = await conn.getMultipleAccountsInfo(keys);
  return keys
    .map((key, i) => ({ key, info: infos[i] }))
    .filter((a) => a.info?.owner.equals(METEORA_DLMM));
}

/// The remaining accounts an `observe` of a DLMM pair needs, read fresh.
export async function dlmmObserveAccounts(conn: Connection, pair: PublicKey, quoteIsX: boolean) {
  const info = await conn.getAccountInfo(pair);
  if (!info) throw new Error("no account at that address");
  const p = decodeDlmmPair(info.data);
  const arrays = await existingArrays(conn, pair, dlmmBinsNeeded(p, quoteIsX));
  return arrays.map((a) => ({ pubkey: a.key, isSigner: false, isWritable: false }));
}

export interface PoolRead {
  dex: Dex;
  address: string;
  base: string;
  quote: string;
  /// For a DLMM pair, whether the quote is X, which is its token 0.
  quoteIsToken0: boolean;
  /// USD per single token, as a float for display and for picking the unit.
  price: number;
  /// The power of ten a unit is, and USD per unit as the program will mark it.
  unitExp: number;
  unitPrice: number;
  depthUsd: number;
  /// Token 0 and token 1 mints, which a DLMM observation is created with.
  mint0: string;
  mint1: string;
  /// A Raydium pool's history ring, passed at listing so the mark can start
  /// from it. Null for a DLMM pair.
  history: string | null;
  /// Whether that history is enough to open the market at listing rather
  /// than after fifteen minutes of watching.
  opensAtListing: boolean;
}

/// Everything the listing page needs to describe a pool it was handed.
///
/// Dispatches on the account's owner, and fails for anything that is neither
/// AMM rather than guessing at a layout.
export async function readPool(
  conn: Connection, address: PublicKey, quoteMint: PublicKey,
): Promise<PoolRead> {
  const info = await conn.getAccountInfo(address);
  if (!info) throw new Error("no account at that address");

  // Which side is the stablecoin is an accident of how the two mint addresses
  // sort, so it is read off the pool rather than assumed, and a pool holding
  // neither side in the quote asset cannot price a market denominated in it.
  const accepted = [quoteMint, ...KNOWN_QUOTE_MINTS].map((m) => m.toBase58());
  const quoteSide = (a: string, b: string) => {
    if (accepted.includes(a)) return true;
    if (accepted.includes(b)) return false;
    throw new Error("neither side of that pool is a stablecoin this pool can price against");
  };

  if (info.owner.equals(RAYDIUM_CLMM)) {
    const p = decodeClmm(info.data);
    const quoteIsToken0 = quoteSide(p.mint0, p.mint1);
    // Priced per billion first: under a micro-dollar a single token reads as
    // zero at six decimals, and the unit has to be chosen from a real figure.
    const price = Number(clmmPrice(p, quoteIsToken0, 9)) / 1e15;
    const unitExp = unitExpFor(price);
    const ring = await conn.getAccountInfo(new PublicKey(p.observationKey));
    // Against the chain's clock, which is the one the program will read.
    const now = (await conn.getBlockTime(await conn.getSlot("confirmed"))) ?? Math.floor(Date.now() / 1000);
    const seed = clmmSeedPrice(p, address.toBase58(), ring ? Uint8Array.from(ring.data) : null,
      quoteIsToken0, unitExp, MIN_OBSERVATION_WINDOW_SEC, BigInt(SEED_MAX_GAP_BPS), now);
    return {
      dex: "raydium-clmm", address: address.toBase58(), quoteIsToken0,
      base: quoteIsToken0 ? p.mint1 : p.mint0, quote: quoteIsToken0 ? p.mint0 : p.mint1,
      price, unitExp,
      unitPrice: Number(clmmPrice(p, quoteIsToken0, unitExp)) / 1e6,
      depthUsd: Number(clmmDepth(p, quoteIsToken0)) / 1e6,
      mint0: p.mint0, mint1: p.mint1,
      history: ring ? p.observationKey : null,
      opensAtListing: seed !== null,
    };
  }

  if (info.owner.equals(METEORA_DLMM)) {
    const p = decodeDlmmPair(info.data);
    const quoteIsX = quoteSide(p.mintX, p.mintY);
    const arrays = await existingArrays(conn, address, dlmmBinsNeeded(p, quoteIsX));
    const [mx, my] = await conn.getMultipleAccountsInfo(
      [new PublicKey(p.mintX), new PublicKey(p.mintY)]);
    if (!mx || !my) throw new Error("could not read the pool's mints");
    const bins = new Map<number, Bin>();
    for (const a of arrays) {
      for (const [id, b] of decodeBinArray(a.info!.data, address.toBase58())) bins.set(id, b);
    }
    const [dx, dy] = [mintDecimals(mx.data), mintDecimals(my.data)];
    const price = Number(dlmmPrice(p, bins, dx, dy, quoteIsX, 9)) / 1e15;
    const unitExp = unitExpFor(price);
    return {
      dex: "meteora-dlmm", address: address.toBase58(), quoteIsToken0: quoteIsX,
      base: quoteIsX ? p.mintY : p.mintX, quote: quoteIsX ? p.mintX : p.mintY,
      price, unitExp,
      unitPrice: Number(dlmmPrice(p, bins, dx, dy, quoteIsX, unitExp)) / 1e6,
      depthUsd: Number(dlmmDepth(p, bins, dx, dy, quoteIsX)) / 1e6,
      mint0: p.mintX, mint1: p.mintY,
      // Meteora keeps no history this program reads, so a pair seasons by
      // being watched.
      history: null, opensAtListing: false,
    };
  }

  throw new Error("that is not a Raydium CLMM or Meteora DLMM pool");
}
