/*
 * Reading the pools a market can be listed against, with no dependencies.
 *
 * Two AMMs, each a line-for-line mirror of its reader in
 * `programs/unwind/src/amm.rs`, truncation included: the mark and the
 * depth a preview shows are the ones the program will compute, or the preview
 * is a quote for a market that does not exist.
 *
 * Pure bytes in, numbers out. The Vercel preview function is built without
 * the repo's dependencies, so there is no web3.js here -- mints come back as
 * base58 strings and the one PDA this needs is derived by hand.
 *
 * Layouts were read by offset and checked against live mainnet accounts:
 * Raydium's SOL/USDC concentrated pool, and Meteora's Bonk/USDC DLMM pair
 * 31p1hptj… with its bin array HhCfX3gi… (active bin -1277, step 80, which
 * priced to the same 3.8098e-6 Meteora's own API reported).
 */

export const RAYDIUM_CLMM_ID = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
export const METEORA_DLMM_ID = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";

/// Matches `SourceKind` in `state/observation.rs`.
export const SOURCE_KIND = { raydiumClmm: 0, orcaWhirlpool: 1, meteoraDlmm: 2 } as const;
export type Dex = "raydium-clmm" | "meteora-dlmm";

const PRICE_SCALE = 1_000_000n;
const BPS = 10_000n;
/// The move depth is quoted against: what does it cost to push the pool 1%?
export const DEPTH_MOVE_BPS = 100n;

// ------------------------------------------------------------------ bytes

const eq = (a: Uint8Array, b: number[]) => b.every((x, i) => a[i] === x);
const u16 = (d: Uint8Array, at: number) => d[at] | (d[at + 1] << 8);
const i32 = (d: Uint8Array, at: number) =>
  d[at] | (d[at + 1] << 8) | (d[at + 2] << 16) | (d[at + 3] << 24);
const uint = (d: Uint8Array, at: number, len: number) => {
  let v = 0n;
  for (let i = len - 1; i >= 0; i--) v = (v << 8n) | BigInt(d[at + i]);
  return v;
};

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function b58encode(bytes: Uint8Array): string {
  let n = uint(Uint8Array.from(bytes).reverse(), 0, bytes.length);
  let s = "";
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) s = "1" + s;
  return s;
}

export function b58decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const v = B58.indexOf(c);
    if (v < 0) throw new Error("not a base58 address");
    n = n * 58n + BigInt(v);
  }
  const out: number[] = [];
  while (n > 0n) { out.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (let i = 0; i < s.length && s[i] === "1"; i++) out.unshift(0);
  return Uint8Array.from(out);
}

const key = (d: Uint8Array, at: number) => b58encode(d.subarray(at, at + 32));

/*
 * A pool's price as USD for one unit of the asset, `PRICE_SCALE` units.
 * Mirrors `to_usd_price` in amm.rs.
 *
 * `num >> bits` is the raw price (token 1 raw per token 0 raw) times
 * `PRICE_SCALE`; it arrives unshifted so the unit can be multiplied in before
 * anything is truncated.
 *
 * The unit is `10^unitExp` tokens, because six decimals of dollars cannot
 * hold a memecoin: Bonk at $0.0000038 is $0.000003 and anything cheaper is
 * zero. Quoting per million keeps the figures the pool actually states, the
 * way exchanges list 1000BONK. Applied after the shift it would only scale
 * what was already lost, which is the mistake the first version made.
 *
 * Inverted pools (the asset is token 1) take the unit on the far side of the
 * inversion, where a small USD price is a large token-0 figure and has
 * precision to spare.
 */
function toUsd(
  num: bigint, bits: bigint, dec0: number, dec1: number, quoteIsToken0: boolean, unitExp: number,
) {
  const unit = 10n ** BigInt(unitExp);
  const shift = (v: bigint) => dec0 >= dec1
    ? v * 10n ** BigInt(dec0 - dec1)
    : v / 10n ** BigInt(dec1 - dec0);
  if (!quoteIsToken0) {
    const ui = shift((num * unit) >> bits);
    if (ui <= 0n) throw new Error("pool price is out of range");
    return ui;
  }
  const ui = shift(num >> bits);
  if (ui <= 0n) throw new Error("pool price is out of range");
  return (PRICE_SCALE * PRICE_SCALE * unit) / ui;
}

/// Rescales a raw token amount to six decimals.
const scaleTo6 = (raw: bigint, decimals: number) =>
  decimals >= 6 ? raw / 10n ** BigInt(decimals - 6) : raw * 10n ** BigInt(6 - decimals);

/// SPL mints keep their decimals at byte 44, in both token programs.
export const mintDecimals = (data: Uint8Array) => data[44];

// ----------------------------------------------------------- Raydium CLMM

/// sha256("account:PoolState")[..8].
const CLMM_DISC = [247, 237, 227, 245, 215, 195, 222, 70];
const CLMM = {
  MINT_0: 73, MINT_1: 105, OBSERVATION_KEY: 201, DEC_0: 233, DEC_1: 234, LIQUIDITY: 237,
  SQRT_PRICE: 253, END: 269, TICK_CURRENT: 269,
};
const SHIFT = 24n;

export interface Clmm {
  mint0: string; mint1: string; dec0: number; dec1: number;
  liquidity: bigint; sqrtPriceX64: bigint;
  /// The pool's history ring, and the tick it sits at now.
  observationKey: string; tick: number;
}

export function decodeClmm(d: Uint8Array): Clmm {
  if (d.length < CLMM.END || !eq(d, CLMM_DISC)) throw new Error("not a Raydium CLMM pool account");
  return {
    mint0: key(d, CLMM.MINT_0), mint1: key(d, CLMM.MINT_1),
    dec0: d[CLMM.DEC_0], dec1: d[CLMM.DEC_1],
    liquidity: uint(d, CLMM.LIQUIDITY, 16), sqrtPriceX64: uint(d, CLMM.SQRT_PRICE, 16),
    observationKey: key(d, CLMM.OBSERVATION_KEY),
    tick: d.length >= CLMM.TICK_CURRENT + 4
      ? new DataView(d.buffer, d.byteOffset + CLMM.TICK_CURRENT, 4).getInt32(0, true) : 0,
  };
}

/// sha256("account:ObservationState")[..8], and the ring's layout. Mirrors
/// `ring` in amm.rs.
const RING_DISC = [122, 174, 197, 53, 129, 9, 165, 132];
const RING = { INDEX: 17, POOL_ID: 19, SAMPLES: 51, SAMPLE_SIZE: 44, COUNT: 100 };
const TICK_FACTORS = [
  0xfffcb933bd6fad37n, 0xfff97272373d4132n, 0xfff2e50f5f656932n, 0xffe5caca7e10e4e6n,
  0xffcb9843d60f6159n, 0xff973b41fa98c081n, 0xff2ea16466c96a38n, 0xfe5dee046a99a2a8n,
  0xfcbe86c7900a88aen, 0xf987a7253ac41317n, 0xf3392b0822b70005n, 0xe7159475a2c29b74n,
  0xd097f3bdfd2022b8n, 0xa9f746462d870fdfn, 0x70d869a156d2a1b8n, 0x31be135f97d08fd9n,
  0x9aa508b5b7a84e1n, 0x5d6af8dedb8119n, 0x2216e584f5fan,
];

/// Mirrors `sqrt_price_at_tick`.
export function sqrtPriceAtTick(tick: number): bigint {
  const abs = Math.abs(tick);
  let r = abs & 1 ? TICK_FACTORS[0] : 1n << 64n;
  for (let i = 1; i < TICK_FACTORS.length; i++) {
    if (abs & (1 << i)) r = (r * TICK_FACTORS[i]) >> 64n;
  }
  return tick > 0 ? ((1n << 128n) - 1n) / r : r;
}

/// The pool's own average tick over at least `windowSec` to `now`, or null
/// when its history does not reach back that far. Mirrors `ring_twap_tick`.
export function ringTwapTick(
  ring: Uint8Array, pool: string, tickNow: number, windowSec: number, now: number,
): number | null {
  if (ring.length < RING.SAMPLES + RING.COUNT * RING.SAMPLE_SIZE || !eq(ring, RING_DISC)) return null;
  if (key(ring, RING.POOL_ID) !== pool) return null;
  const v = new DataView(ring.buffer, ring.byteOffset, ring.length);
  const sample = (i: number) => {
    const at = RING.SAMPLES + i * RING.SAMPLE_SIZE;
    return { ts: v.getUint32(at, true), cum: v.getBigInt64(at + 4, true) };
  };
  const idx = v.getUint16(RING.INDEX, true);
  if (idx >= RING.COUNT) return null;
  const last = sample(idx);
  if (last.ts === 0 || last.ts > now) return null;
  const cumNow = last.cum + BigInt(tickNow) * BigInt(now - last.ts);
  for (let k = 0; k < RING.COUNT; k++) {
    const s = sample((idx + RING.COUNT - k) % RING.COUNT);
    if (s.ts === 0) return null;
    if (s.ts <= now - windowSec) {
      const dt = BigInt(now - s.ts), diff = cumNow - s.cum;
      // Floor, as `div_euclid` does for a positive divisor.
      const q = diff / dt;
      return Number(diff % dt !== 0n && diff < 0n ? q - 1n : q);
    }
  }
  return null;
}

/// Whether a market listed on this pool opens at listing: its history spans
/// the window and its spot is within `maxGapBps` of that average. Mirrors
/// `seed_from_history`. Returns the average it would open at, or null.
export function clmmSeedPrice(
  p: Clmm, pool: string, ring: Uint8Array | null, quoteIsToken0: boolean, unitExp: number,
  windowSec: number, maxGapBps: bigint, now: number,
): bigint | null {
  if (!ring) return null;
  const t = ringTwapTick(ring, pool, p.tick, windowSec, now);
  if (t === null) return null;
  const twap = clmmPrice({ ...p, sqrtPriceX64: sqrtPriceAtTick(t) }, quoteIsToken0, unitExp);
  const spot = clmmPrice(p, quoteIsToken0, unitExp);
  const gap = spot > twap ? spot - twap : twap - spot;
  return gap * BPS > twap * maxGapBps ? null : twap;
}

/// Mark in USD for `10^unitExp` of the asset, `PRICE_SCALE` units. Mirrors
/// `clmm_spot_price`.
export function clmmPrice(p: Clmm, quoteIsToken0: boolean, unitExp = 0): bigint {
  if (p.sqrtPriceX64 === 0n) throw new Error("pool has no price");
  const q = p.sqrtPriceX64 >> SHIFT;
  return toUsd(q * q * PRICE_SCALE, 128n - 2n * SHIFT, p.dec0, p.dec1, quoteIsToken0, unitExp);
}

/// USD to move the pool 1%, `PRICE_SCALE` units. Mirrors `clmm_depth_usd`:
/// `Δy = L·Δ√P`, with `Δ√P` taken as half the move.
export function clmmDepth(p: Clmm, quoteIsToken0: boolean): bigint {
  if (p.liquidity === 0n || p.sqrtPriceX64 === 0n) return 0n;
  const scaled = (p.liquidity * p.sqrtPriceX64) >> 64n;
  const raw = (scaled * (DEPTH_MOVE_BPS / 2n)) / BPS;
  return scaleTo6(raw, quoteIsToken0 ? p.dec0 : p.dec1);
}

// ----------------------------------------------------------- Meteora DLMM

/// sha256("account:LbPair")[..8] and sha256("account:BinArray")[..8].
const PAIR_DISC = [33, 11, 49, 98, 181, 101, 177, 13];
const BIN_ARRAY_DISC = [92, 142, 92, 220, 5, 148, 70, 181];
/// `LbPair`: discriminator, then 32 bytes of static and 32 of variable
/// parameters, then a run of small fields to the mints.
const PAIR = { ACTIVE_ID: 76, BIN_STEP: 80, MINT_X: 88, MINT_Y: 120, END: 152 };
/// `BinArray`: discriminator, index (i64), version, 7 of padding, the pair,
/// then 70 bins of 144 bytes: amount_x u64, amount_y u64, price u128 (Q64.64,
/// raw Y per raw X), and fields this does not read.
export const BINS_PER_ARRAY = 70;
const ARRAY = { INDEX: 8, PAIR: 24, BINS: 56, BIN_SIZE: 144, END: 56 + 70 * 144 };

export interface DlmmPair { mintX: string; mintY: string; activeId: number; binStep: number }
export interface Bin { amountX: bigint; amountY: bigint; price: bigint }

export function decodeDlmmPair(d: Uint8Array): DlmmPair {
  if (d.length < PAIR.END || !eq(d, PAIR_DISC)) throw new Error("not a Meteora DLMM pair account");
  return {
    mintX: key(d, PAIR.MINT_X), mintY: key(d, PAIR.MINT_Y),
    activeId: i32(d, PAIR.ACTIVE_ID), binStep: u16(d, PAIR.BIN_STEP),
  };
}

/// Which bin array holds a bin. Floor division, so bin -1 is in array -1.
export const binArrayIndex = (binId: number) => Math.floor(binId / BINS_PER_ARRAY);

/// The bins of one array, keyed by bin id, after checking it belongs to `pair`.
export function decodeBinArray(d: Uint8Array, pair: string): Map<number, Bin> {
  if (d.length < ARRAY.END || !eq(d, BIN_ARRAY_DISC)) throw new Error("not a DLMM bin array");
  if (key(d, ARRAY.PAIR) !== pair) throw new Error("bin array belongs to another pair");
  const index = Number(BigInt.asIntN(64, uint(d, ARRAY.INDEX, 8)));
  const bins = new Map<number, Bin>();
  for (let i = 0; i < BINS_PER_ARRAY; i++) {
    const at = ARRAY.BINS + i * ARRAY.BIN_SIZE;
    bins.set(index * BINS_PER_ARRAY + i, {
      amountX: uint(d, at, 8), amountY: uint(d, at + 8, 8), price: uint(d, at + 16, 16),
    });
  }
  return bins;
}

/// How many bins a 1% move crosses: the first `n` with `n · step ≥ 100bp`.
export const binsPerMove = (binStep: number) =>
  Math.max(1, Math.ceil(Number(DEPTH_MOVE_BPS) / binStep));

/// The bins the price and depth read: the active one and the next `n - 1` in
/// the direction a rising USD price walks. That is up the ids when the asset
/// is X, and down them when it is Y, since then USD per asset is `1 / P`.
export function dlmmBinsNeeded(p: DlmmPair, quoteIsX: boolean): number[] {
  const n = binsPerMove(p.binStep);
  return Array.from({ length: n }, (_, i) => p.activeId + (quoteIsX ? -i : i));
}

/// Mark in USD for `10^unitExp` of the asset, `PRICE_SCALE` units, from the
/// active bin's own price. Mirrors `dlmm_spot_price`. An active bin the caller
/// could not supply, or one with no price recorded, is an error: a market
/// halts rather than guessing.
export function dlmmPrice(
  p: DlmmPair, bins: Map<number, Bin>, decX: number, decY: number, quoteIsX: boolean,
  unitExp = 0,
): bigint {
  const active = bins.get(p.activeId);
  if (!active || active.price === 0n) throw new Error("active bin has no price");
  return toUsd(active.price * PRICE_SCALE, 64n, decX, decY, quoteIsX, unitExp);
}

/// USD to move the pool 1%, `PRICE_SCALE` units. Mirrors `dlmm_depth_usd`.
///
/// The quote a buyer pays to clear every bin a 1% rise crosses: the asset
/// sitting in those bins, valued at each bin's price. Bins not supplied count
/// as empty, so a missing array can only make depth, and so limits, smaller.
export function dlmmDepth(
  p: DlmmPair, bins: Map<number, Bin>, decX: number, decY: number, quoteIsX: boolean,
): bigint {
  let raw = 0n;
  for (const id of dlmmBinsNeeded(p, quoteIsX)) {
    const b = bins.get(id);
    if (!b || b.price === 0n) continue;
    raw += quoteIsX ? (b.amountY << 64n) / b.price : (b.amountX * b.price) >> 64n;
  }
  return scaleTo6(raw, quoteIsX ? decX : decY);
}

// ------------------------------------------------------ PDA, without web3

/// ed25519: p = 2^255 - 19, d = -121665 / 121666.
const P = 2n ** 255n - 19n;
const modp = (a: bigint) => ((a % P) + P) % P;
const powp = (b: bigint, e: bigint) => {
  let r = 1n; b = modp(b);
  while (e > 0n) { if (e & 1n) r = (r * b) % P; b = (b * b) % P; e >>= 1n; }
  return r;
};
const D = modp(-121665n * powp(121666n, P - 2n));

/// Whether 32 bytes decompress to a point, as curve25519-dalek decides it. A
/// program address must not, which is what the bump search is for.
function onCurve(bytes: Uint8Array): boolean {
  const y = uint(bytes, 0, 32) & ((1n << 255n) - 1n);
  if (y >= P) return false;
  const y2 = (y * y) % P;
  const x2 = modp((y2 - 1n) * powp(D * y2 + 1n, P - 2n));
  if (x2 === 0n) return (bytes[31] & 0x80) === 0;
  return powp(x2, (P - 1n) / 2n) === 1n;
}

async function sha256(parts: Uint8Array[]): Promise<Uint8Array> {
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { all.set(p, at); at += p.length; }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", all));
}

export async function findProgramAddress(seeds: Uint8Array[], programId: string) {
  const program = b58decode(programId);
  const marker = new TextEncoder().encode("ProgramDerivedAddress");
  for (let bump = 255; bump >= 0; bump--) {
    const h = await sha256([...seeds, Uint8Array.of(bump), program, marker]);
    if (!onCurve(h)) return b58encode(h);
  }
  throw new Error("no viable bump");
}

/// The bin array account holding array `index` of `pair`.
export function binArrayAddress(pair: string, index: number) {
  const le = new Uint8Array(8);
  new DataView(le.buffer).setBigInt64(0, BigInt(index), true);
  return findProgramAddress(
    [new TextEncoder().encode("bin_array"), b58decode(pair), le], METEORA_DLMM_ID);
}
