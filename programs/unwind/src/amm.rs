//! Reading a spot price out of an AMM pool account.
//!
//! This is the price source for assets Pyth does not cover. It is deliberately
//! thin: it reports what the pool says *right now*, with no smoothing and no
//! opinion, because a spot reading is not a mark and must not be mistaken for
//! one. `Observation` is what turns a sequence of these into something a
//! position can be liquidated against.
//!
//! Two AMMs, both read by offset rather than through their crates, the same
//! reason `oracle.rs` reads Pyth by hand: the dependencies pin a borsh major
//! this program cannot link against.
//!
//! Raydium's `PoolState` offsets were computed from the field order in
//! raydium-clmm and checked against a live mainnet account (the SOL/USDC pool
//! at 3ucNos4N..., which parsed to $108.73 against a spot of roughly $111 at
//! the time). Meteora's `LbPair` and `BinArray` were checked against the
//! Bonk/USDC pair 31p1hptj... and its bin array HhCfX3gi..., whose bytes are
//! kept in `fixtures/` as the test vectors below.
//!
//! `scripts/pools.ts` is a line-for-line mirror of every reader here,
//! truncation order included. A listing preview quotes what that file
//! computes, so a change to the arithmetic on one side and not the other makes
//! the preview a quote for a market that does not exist.

use crate::constants::*;
use crate::errors::PerpError;
use anchor_lang::prelude::*;

/// Raydium's concentrated-liquidity program.
pub const RAYDIUM_CLMM_ID: Pubkey = pubkey!("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");

/// sha256("account:PoolState")[..8], confirmed against a live account.
pub const POOL_STATE_DISCRIMINATOR: [u8; 8] = [247, 237, 227, 245, 215, 195, 222, 70];

/// Field offsets into the account data, discriminator included.
mod off {
    pub const MINT_DECIMALS_0: usize = 233;
    pub const LIQUIDITY: usize = 237;
    pub const MINT_DECIMALS_1: usize = 234;
    pub const SQRT_PRICE_X64: usize = 253;
    pub const END: usize = 269;
    /// Past `END`, so read only by the history path, which checks the length
    /// for itself.
    pub const OBSERVATION_KEY: usize = 201;
    pub const TICK_CURRENT: usize = 269;
}

/// How far the square root is shifted down before squaring.
///
/// `sqrt_price_x64` squared does not fit in a u128, so precision has to be
/// traded for range. 24 bits off a ~63-bit root costs about one part in 2^39 —
/// immaterial next to a 4bp spread — while keeping the square and the scaling
/// multiply inside u128 for every pool whose price lands in a range anyone
/// would list.
const SHIFT: u32 = 24;

/// The price move the depth figure is quoted against: what does it cost to
/// push this pool one percent?
///
/// A percent rather than a tick or a basis point because it is the size of
/// move that actually matters to a leveraged position, and because it is a
/// number anyone can sanity-check against a pool they know.
pub const DEPTH_MOVE_BPS: u128 = 100;

/// USD it takes to move this pool `DEPTH_MOVE_BPS`, scaled to `PRICE_SCALE`.
///
/// For a concentrated pool the quote-token input that moves the price is
/// `Δy = L · Δ√P`, so the cost of a move is a direct read of the account
/// rather than a simulation: no tick traversal, no swap, no trust in anyone's
/// reported liquidity.
///
/// The square root is why the arithmetic works out. Moving price by a fraction
/// `d` moves its root by `√(1+d) − 1`, which for small `d` is `d/2` to within
/// a quarter of a percent, so half the move in basis points is the whole
/// approximation, and it is conservative in the direction that matters (it
/// reports slightly less depth than exists, so limits come out tighter).
///
/// Zero when the pool has no active liquidity, which reads downstream as
/// maximum uncertainty and halts the market rather than quoting into it.
pub fn clmm_depth_usd(
    account: &AccountInfo,
    expected_pool: &Pubkey,
    quote_is_token_0: bool,
) -> Result<u64> {
    require_keys_eq!(*account.key, *expected_pool, PerpError::WrongOracleFeed);
    let data = account.try_borrow_data()?;
    check_clmm_pool(account.owner, &data)?;

    let dec_0 = data[off::MINT_DECIMALS_0];
    let dec_1 = data[off::MINT_DECIMALS_1];
    let liquidity = read_u128(&data, off::LIQUIDITY)?;
    let sqrt_price_x64 = read_u128(&data, off::SQRT_PRICE_X64)?;
    if liquidity == 0 || sqrt_price_x64 == 0 {
        return Ok(0);
    }

    // The quote side is whichever token is not the asset. When the stablecoin
    // is token 0 the roles swap and the cost of the move is `Δx`, which is the
    // same expression against `1/√P`, so the reading is taken in token-0
    // terms and converted, rather than deriving a second formula.
    let quote_decimals = if quote_is_token_0 { dec_0 } else { dec_1 };

    // `(L · √P) >> 64` before scaling: the product is the large term and the
    // shift is what brings it back into range for the basis-point multiply.
    let scaled = liquidity
        .checked_mul(sqrt_price_x64)
        .ok_or(PerpError::MathOverflow)?
        >> 64;
    let raw = scaled
        .checked_mul(DEPTH_MOVE_BPS / 2)
        .ok_or(PerpError::MathOverflow)?
        / BPS;
    let depth = to_usd_scale(raw, quote_decimals)?;
    u64::try_from(depth).map_err(|_| PerpError::MathOverflow.into())
}

/// Checks an account is a Raydium pool before anything is read out of it.
/// Split out so `create_observation` can refuse a wrong account at listing
/// rather than leaving the first crank to find out.
pub fn check_clmm_pool(owner: &Pubkey, data: &[u8]) -> Result<()> {
    require_keys_eq!(*owner, RAYDIUM_CLMM_ID, PerpError::WrongOracleOwner);
    require!(data.len() >= off::END, PerpError::InvalidOracleAccount);
    require!(
        data[..8] == POOL_STATE_DISCRIMINATOR,
        PerpError::InvalidOracleAccount
    );
    Ok(())
}

fn read_u128(data: &[u8], at: usize) -> Result<u128> {
    Ok(u128::from_le_bytes(
        data[at..at + 16]
            .try_into()
            .map_err(|_| error!(PerpError::InvalidOracleAccount))?,
    ))
}

/// Rescales a raw token amount to `PRICE_SCALE` (six decimals).
pub(crate) fn to_usd_scale(raw: u128, decimals: u8) -> Result<u128> {
    if decimals >= 6 {
        let shift = 10u128
            .checked_pow((decimals - 6) as u32)
            .ok_or(PerpError::MathOverflow)?;
        Ok(raw / shift)
    } else {
        let shift = 10u128
            .checked_pow((6 - decimals) as u32)
            .ok_or(PerpError::MathOverflow)?;
        raw.checked_mul(shift).ok_or(PerpError::MathOverflow.into())
    }
}

/// The pool's current price, in USD for `10^unit_exp` of the asset, scaled
/// to `PRICE_SCALE`.
///
/// `quote_is_token_0` inverts the reading. Raydium orders a pool's mints by
/// public key, so whether the stablecoin is token 0 or token 1 is an accident
/// of the mint addresses and has to be recorded per pool rather than assumed.
pub fn clmm_spot_price(
    account: &AccountInfo,
    expected_pool: &Pubkey,
    quote_is_token_0: bool,
    unit_exp: u8,
) -> Result<u64> {
    require_keys_eq!(*account.key, *expected_pool, PerpError::WrongOracleFeed);
    let data = account.try_borrow_data()?;
    check_clmm_pool(account.owner, &data)?;

    let dec_0 = data[off::MINT_DECIMALS_0];
    let dec_1 = data[off::MINT_DECIMALS_1];
    let sqrt_price_x64 = read_u128(&data, off::SQRT_PRICE_X64)?;
    require!(sqrt_price_x64 > 0, PerpError::InvalidOraclePrice);

    to_usd_price(
        clmm_price_num(sqrt_price_x64)?,
        CLMM_PRICE_BITS,
        dec_0,
        dec_1,
        quote_is_token_0,
        unit_exp,
    )
}

/// Fractional bits left in `clmm_price_num`: the root carried 64, the shift
/// took `SHIFT` off it, and squaring doubled what remained.
const CLMM_PRICE_BITS: u32 = 128 - 2 * SHIFT;

/// `(sqrt_price_x64 >> SHIFT)^2 · PRICE_SCALE`: the raw price, scaled, with
/// `CLMM_PRICE_BITS` of fraction still on it.
///
/// The fraction is left on rather than shifted out here so that
/// `to_usd_price` can multiply the unit in first. Shifting first would throw
/// away exactly the digits a unit of a million tokens exists to keep.
///
/// Out-of-range is an error rather than a wrapped number: a pool priced past
/// what this can square is one the program declines to read, which is the safe
/// failure. Silently truncating here would be a wrong mark, and a wrong mark
/// is a liquidation.
fn clmm_price_num(sqrt_price_x64: u128) -> Result<u128> {
    let q = sqrt_price_x64 >> SHIFT;
    let squared = q.checked_mul(q).ok_or(PerpError::MathOverflow)?;
    Ok(squared
        .checked_mul(PRICE_SCALE)
        .ok_or(PerpError::MathOverflow)?)
}

/// Largest `unit_exp` a market may be quoted in: a billion tokens.
///
/// Also what keeps the unit multiply below inside u128 for any price a pool
/// in either format can hold without already having overflowed upstream.
pub const MAX_UNIT_EXP: u8 = 9;

/// A price read off a pool, as USD for `10^unit_exp` of the asset.
///
/// `num >> bits` is the raw price (token 1 raw per token 0 raw) times
/// `PRICE_SCALE`; both readers hand it over with the fraction still attached.
///
/// The unit exists because six decimals of dollars cannot hold a memecoin:
/// Bonk at $0.0000038 reads $0.000003, and anything cheaper reads zero.
/// Quoting per million keeps the significant figures, the way exchanges list
/// 1000BONK. It is multiplied in before the fraction is shifted out, so it
/// adds precision rather than scaling what was already lost.
///
/// Inverted pools apply it on the far side of the inversion: the asset is
/// token 1 there, and the unit multiplies the USD figure, not the token-0 one.
///
/// Mirrors `toUsd` in `scripts/pools.ts`. Every multiply is checked: a price
/// this cannot hold is a market that halts, never one that wraps.
fn to_usd_price(
    num: u128,
    bits: u32,
    dec_0: u8,
    dec_1: u8,
    quote_is_token_0: bool,
    unit_exp: u8,
) -> Result<u64> {
    require!(unit_exp <= MAX_UNIT_EXP, PerpError::InvalidParameter);
    let unit = 10u128.pow(unit_exp as u32);

    let price = if !quote_is_token_0 {
        let ui = apply_decimals(
            num.checked_mul(unit).ok_or(PerpError::MathOverflow)? >> bits,
            dec_0,
            dec_1,
        )?;
        require!(ui > 0, PerpError::InvalidOraclePrice);
        ui
    } else {
        // The pool quotes the stablecoin per asset the wrong way round.
        let ui = apply_decimals(num >> bits, dec_0, dec_1)?;
        require!(ui > 0, PerpError::InvalidOraclePrice);
        (PRICE_SCALE * PRICE_SCALE * unit) / ui
    };
    require!(price > 0, PerpError::InvalidOraclePrice);
    u64::try_from(price).map_err(|_| PerpError::MathOverflow.into())
}

/// Converts a raw-unit price into one between the tokens' display units.
pub(crate) fn apply_decimals(raw_scaled: u128, dec_0: u8, dec_1: u8) -> Result<u128> {
    if dec_0 >= dec_1 {
        let shift = 10u128
            .checked_pow((dec_0 - dec_1) as u32)
            .ok_or(PerpError::MathOverflow)?;
        raw_scaled.checked_mul(shift).ok_or(PerpError::MathOverflow.into())
    } else {
        let shift = 10u128
            .checked_pow((dec_1 - dec_0) as u32)
            .ok_or(PerpError::MathOverflow)?;
        Ok(raw_scaled / shift)
    }
}

// ------------------------------------------------------------ Meteora DLMM

// ------------------------------------------------------ Raydium history

/// sha256("account:ObservationState")[..8], confirmed against a live account.
pub const OBSERVATION_STATE_DISCRIMINATOR: [u8; 8] = [122, 174, 197, 53, 129, 9, 165, 132];

/// Raydium's `ObservationState`: a ring of the pool's own price history,
/// `(timestamp, cumulative tick)` samples written as it trades, roughly one
/// every fifteen seconds. Offsets from the field order in raydium-clmm and
/// checked against the SOL/USDC pool's ring (3Y695CuQ...), whose bytes are in
/// `fixtures/`.
mod ring {
    pub const INDEX: usize = 17;
    pub const POOL_ID: usize = 19;
    pub const SAMPLES: usize = 51;
    pub const SAMPLE_SIZE: usize = 44;
    pub const COUNT: usize = 100;
    pub const END: usize = SAMPLES + COUNT * SAMPLE_SIZE;
}

/// `2^64 / sqrt(1.0001)^(2^i)`, floored: the factors a tick's square-root
/// price is built from, one per bit. Generated at 80 digits rather than copied,
/// and they agree with Raydium's own to every bit Raydium keeps.
const TICK_FACTORS: [u128; 19] = [
    0xfffcb933bd6fad37, 0xfff97272373d4132, 0xfff2e50f5f656932, 0xffe5caca7e10e4e6,
    0xffcb9843d60f6159, 0xff973b41fa98c081, 0xff2ea16466c96a38, 0xfe5dee046a99a2a8,
    0xfcbe86c7900a88ae, 0xf987a7253ac41317, 0xf3392b0822b70005, 0xe7159475a2c29b74,
    0xd097f3bdfd2022b8, 0xa9f746462d870fdf, 0x70d869a156d2a1b8, 0x31be135f97d08fd9,
    0x9aa508b5b7a84e1, 0x5d6af8dedb8119, 0x2216e584f5fa,
];

/// Ticks past this are outside what Raydium itself allows.
const MAX_TICK: i32 = 443_636;

/// `sqrt(1.0001^tick)` in Q64.64, the form a pool stores its price in.
pub fn sqrt_price_at_tick(tick: i32) -> Result<u128> {
    require!(tick.unsigned_abs() <= MAX_TICK as u32, PerpError::InvalidOraclePrice);
    let abs = tick.unsigned_abs();
    let mut ratio: u128 = if abs & 1 != 0 { TICK_FACTORS[0] } else { 1u128 << 64 };
    for (i, f) in TICK_FACTORS.iter().enumerate().skip(1) {
        if abs & (1 << i) != 0 {
            ratio = ratio.checked_mul(*f).ok_or(PerpError::MathOverflow)? >> 64;
        }
    }
    if tick > 0 {
        ratio = u128::MAX / ratio;
    }
    Ok(ratio)
}

/// The pool's own time-weighted average price over at least `window_sec`,
/// read from its history ring, in the same units as `clmm_spot_price`.
///
/// This is what lets a market on a pool that has been trading for a while
/// open at listing instead of watching it for fifteen minutes first: the
/// watching has already been done, by the pool, on chain. It proves the same
/// thing the wait does. Moving a time-weighted average means holding the pool
/// at the false price for the whole window, which the pool records, so a
/// listing seeded this way costs a manipulator exactly what one that waited
/// would have.
///
/// `None` when the history cannot answer: the ring does not reach back far
/// enough yet, or has never been written. The market then seasons the slow
/// way, which is always available. The ring's key is checked against the one
/// the pool records, so a lister cannot hand in some other pool's history.
pub fn clmm_twap_price(
    pool: &AccountInfo,
    expected_pool: &Pubkey,
    history: &AccountInfo,
    quote_is_token_0: bool,
    unit_exp: u8,
    window_sec: i64,
    now: i64,
) -> Result<Option<u64>> {
    require_keys_eq!(*pool.key, *expected_pool, PerpError::WrongOracleFeed);
    let p = pool.try_borrow_data()?;
    check_clmm_pool(pool.owner, &p)?;
    require!(p.len() >= off::TICK_CURRENT + 4, PerpError::InvalidOracleAccount);
    require!(
        history.key.as_ref() == &p[off::OBSERVATION_KEY..off::OBSERVATION_KEY + 32],
        PerpError::WrongOracleFeed
    );
    require_keys_eq!(*history.owner, RAYDIUM_CLMM_ID, PerpError::WrongOracleOwner);
    let h = history.try_borrow_data()?;
    require!(
        h.len() >= ring::END && h[..8] == OBSERVATION_STATE_DISCRIMINATOR,
        PerpError::InvalidOracleAccount
    );
    require!(
        &h[ring::POOL_ID..ring::POOL_ID + 32] == expected_pool.as_ref(),
        PerpError::WrongOracleFeed
    );

    let tick_now = i32::from_le_bytes(p[off::TICK_CURRENT..off::TICK_CURRENT + 4].try_into().unwrap());
    let twap = match ring_twap_tick(&h, tick_now, window_sec, now) {
        Some(t) => t,
        None => return Ok(None),
    };
    let sqrt = sqrt_price_at_tick(twap)?;
    Ok(Some(to_usd_price(
        clmm_price_num(sqrt)?,
        CLMM_PRICE_BITS,
        p[off::MINT_DECIMALS_0],
        p[off::MINT_DECIMALS_1],
        quote_is_token_0,
        unit_exp,
    )?))
}

/// The average tick over the ring's samples reaching back at least
/// `window_sec` from `now`, carried forward to `now` at the pool's current
/// tick: a pool that has not traded since its last sample has sat at that
/// tick the whole time, which is exactly what the average should say.
/// Rounded toward negative infinity, as Raydium and Uniswap round it.
fn ring_twap_tick(h: &[u8], tick_now: i32, window_sec: i64, now: i64) -> Option<i32> {
    let sample = |i: usize| {
        let at = ring::SAMPLES + i * ring::SAMPLE_SIZE;
        let ts = u32::from_le_bytes(h[at..at + 4].try_into().unwrap()) as i64;
        let cum = i64::from_le_bytes(h[at + 4..at + 12].try_into().unwrap());
        (ts, cum)
    };
    let idx = u16::from_le_bytes(h[ring::INDEX..ring::INDEX + 2].try_into().unwrap()) as usize;
    if idx >= ring::COUNT {
        return None;
    }
    let (last_ts, last_cum) = sample(idx);
    if last_ts == 0 || last_ts > now {
        return None;
    }
    let cum_now = last_cum.checked_add((tick_now as i64).checked_mul(now - last_ts)?)?;
    // Newest first, for the first sample old enough to span the window.
    for k in 0..ring::COUNT {
        let (ts, cum) = sample((idx + ring::COUNT - k) % ring::COUNT);
        if ts == 0 {
            return None;
        }
        if ts <= now - window_sec {
            let dt = now - ts;
            let t = (cum_now.checked_sub(cum)?).div_euclid(dt);
            return i32::try_from(t).ok();
        }
    }
    None
}



/// Meteora's liquidity-book program.
pub const METEORA_DLMM_ID: Pubkey = pubkey!("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");

/// sha256("account:LbPair")[..8] and sha256("account:BinArray")[..8].
pub const LB_PAIR_DISCRIMINATOR: [u8; 8] = [33, 11, 49, 98, 181, 101, 177, 13];
pub const BIN_ARRAY_DISCRIMINATOR: [u8; 8] = [92, 142, 92, 220, 5, 148, 70, 181];

/// Bins per `BinArray` account. A bin's array is `floor(id / 70)`, floored
/// rather than truncated, so bin -1 lives in array -1 and not array 0.
pub const BINS_PER_ARRAY: i32 = 70;

mod dlmm_off {
    /// `LbPair`: discriminator, then 32 bytes of static and 32 of variable
    /// parameters, then a run of small fields to the mints.
    pub const ACTIVE_ID: usize = 76;
    pub const BIN_STEP: usize = 80;
    pub const MINT_X: usize = 88;
    pub const MINT_Y: usize = 120;
    pub const PAIR_END: usize = 152;

    /// `BinArray`: discriminator, index (i64), version, 7 of padding, the
    /// pair, then the bins: amount_x u64, amount_y u64, price u128 (Q64.64,
    /// raw Y per raw X), and fields this does not read.
    pub const ARRAY_INDEX: usize = 8;
    pub const ARRAY_PAIR: usize = 24;
    pub const BINS: usize = 56;
    pub const BIN_SIZE: usize = 144;
    pub const ARRAY_END: usize = BINS + 70 * BIN_SIZE;
}

/// What the program needs from an `LbPair`. The pair carries no decimals,
/// which is why `create_observation` reads them off the mints instead.
#[derive(Clone, Copy, Debug)]
pub struct DlmmPair {
    pub active_id: i32,
    pub bin_step: u16,
    pub mint_x: Pubkey,
    pub mint_y: Pubkey,
}

/// Parses an `LbPair` after checking its owner and discriminator.
pub fn parse_dlmm_pair(owner: &Pubkey, data: &[u8]) -> Result<DlmmPair> {
    require_keys_eq!(*owner, METEORA_DLMM_ID, PerpError::WrongOracleOwner);
    require!(data.len() >= dlmm_off::PAIR_END, PerpError::InvalidOracleAccount);
    require!(data[..8] == LB_PAIR_DISCRIMINATOR, PerpError::InvalidOracleAccount);
    let at = dlmm_off::ACTIVE_ID;
    let bs = dlmm_off::BIN_STEP;
    let pair = DlmmPair {
        active_id: i32::from_le_bytes([data[at], data[at + 1], data[at + 2], data[at + 3]]),
        bin_step: u16::from_le_bytes([data[bs], data[bs + 1]]),
        mint_x: Pubkey::new_from_array(read_key(data, dlmm_off::MINT_X)),
        mint_y: Pubkey::new_from_array(read_key(data, dlmm_off::MINT_Y)),
    };
    // A zero step prices every bin the same and would make the depth walk
    // endless; no real pair has one, so one that claims to is refused.
    require!(pair.bin_step > 0, PerpError::InvalidOracleAccount);
    Ok(pair)
}

fn read_key(data: &[u8], at: usize) -> [u8; 32] {
    let mut k = [0u8; 32];
    k.copy_from_slice(&data[at..at + 32]);
    k
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Bin {
    pub amount_x: u64,
    pub amount_y: u64,
    /// Q64.64, raw Y per raw X.
    pub price: u128,
}

/// A bin array that has been checked to belong to the pair being read.
pub struct BinArray<'a> {
    index: i64,
    data: &'a [u8],
}

impl<'a> BinArray<'a> {
    /// Checks owner, discriminator and pair before any bin is trusted.
    ///
    /// The pair check is the one that matters. Bin arrays are passed in by
    /// whoever cranks, and an array from a different pair is a well-formed
    /// account holding somebody else's prices: owner and discriminator alone
    /// would accept it.
    pub fn parse(owner: &Pubkey, data: &'a [u8], pair: &Pubkey) -> Result<Self> {
        require_keys_eq!(*owner, METEORA_DLMM_ID, PerpError::WrongOracleOwner);
        require!(data.len() >= dlmm_off::ARRAY_END, PerpError::InvalidOracleAccount);
        require!(
            data[..8] == BIN_ARRAY_DISCRIMINATOR,
            PerpError::InvalidOracleAccount
        );
        require!(
            read_key(data, dlmm_off::ARRAY_PAIR) == pair.to_bytes(),
            PerpError::WrongOracleFeed
        );
        let at = dlmm_off::ARRAY_INDEX;
        let index = i64::from_le_bytes(
            data[at..at + 8]
                .try_into()
                .map_err(|_| error!(PerpError::InvalidOracleAccount))?,
        );
        Ok(Self { index, data })
    }

    fn bin(&self, id: i32) -> Option<Bin> {
        if id.div_euclid(BINS_PER_ARRAY) as i64 != self.index {
            return None;
        }
        let at = dlmm_off::BINS + id.rem_euclid(BINS_PER_ARRAY) as usize * dlmm_off::BIN_SIZE;
        let d = self.data;
        Some(Bin {
            amount_x: u64::from_le_bytes(d[at..at + 8].try_into().ok()?),
            amount_y: u64::from_le_bytes(d[at + 8..at + 16].try_into().ok()?),
            price: u128::from_le_bytes(d[at + 16..at + 32].try_into().ok()?),
        })
    }
}

fn find_bin(arrays: &[BinArray], id: i32) -> Option<Bin> {
    arrays.iter().find_map(|a| a.bin(id))
}

/// How many bins a `DEPTH_MOVE_BPS` move crosses: the first `n` with
/// `n · step ≥ 100bp`, and never fewer than the active bin itself.
pub fn dlmm_bins_per_move(bin_step: u16) -> i32 {
    let step = bin_step.max(1) as u128;
    (DEPTH_MOVE_BPS.div_ceil(step) as i32).max(1)
}

/// The bins the price and depth read: the active one and the next `n - 1` in
/// the direction a rising USD price walks. That is up the ids when the asset
/// is X, and down them when it is Y, since then USD per asset is `1 / P`.
pub fn dlmm_bins_needed(pair: &DlmmPair, quote_is_x: bool) -> impl Iterator<Item = i32> {
    let active = pair.active_id;
    (0..dlmm_bins_per_move(pair.bin_step)).map(move |i| if quote_is_x { active - i } else { active + i })
}

/// Mark in USD for `10^unit_exp` of the asset, `PRICE_SCALE` units, from the
/// active bin's own price rather than from reserves.
///
/// An active bin nobody supplied, or one with no price recorded, is an error:
/// the market halts rather than guessing. Reading the stored price rather than
/// recomputing `(1 + step)^id` is deliberate, since it is the number the pair
/// itself swaps at, and a recomputation is a second implementation of
/// Meteora's rounding that could only ever disagree with it.
pub fn dlmm_spot_price(
    pair: &DlmmPair,
    arrays: &[BinArray],
    dec_x: u8,
    dec_y: u8,
    quote_is_x: bool,
    unit_exp: u8,
) -> Result<u64> {
    let active = find_bin(arrays, pair.active_id).ok_or(PerpError::InvalidOracleAccount)?;
    require!(active.price > 0, PerpError::InvalidOraclePrice);
    let num = active
        .price
        .checked_mul(PRICE_SCALE)
        .ok_or(PerpError::MathOverflow)?;
    to_usd_price(num, 64, dec_x, dec_y, quote_is_x, unit_exp)
}

/// USD to move the pair `DEPTH_MOVE_BPS`, `PRICE_SCALE` units.
///
/// The quote a buyer pays to clear every bin a one percent rise crosses: the
/// asset sitting in those bins, valued at each bin's own price. That is the
/// liquidity-book equivalent of the CLMM's `L · Δ√P`, read bin by bin instead
/// of from a curve.
///
/// Bins not supplied count as empty, so leaving an array out can only make
/// depth, and so the confidence band and budget, worse. That is the right way
/// for a crank's omission to fail: the cranker cannot buy a tighter market by
/// withholding accounts.
pub fn dlmm_depth_usd(
    pair: &DlmmPair,
    arrays: &[BinArray],
    dec_x: u8,
    dec_y: u8,
    quote_is_x: bool,
) -> Result<u64> {
    let mut raw: u128 = 0;
    for id in dlmm_bins_needed(pair, quote_is_x) {
        let Some(b) = find_bin(arrays, id) else { continue };
        if b.price == 0 {
            continue;
        }
        let quote = if quote_is_x {
            ((b.amount_y as u128) << 64) / b.price
        } else {
            (b.amount_x as u128)
                .checked_mul(b.price)
                .ok_or(PerpError::MathOverflow)?
                >> 64
        };
        raw = raw.checked_add(quote).ok_or(PerpError::MathOverflow)?;
    }
    let depth = to_usd_scale(raw, if quote_is_x { dec_x } else { dec_y })?;
    u64::try_from(depth).map_err(|_| PerpError::MathOverflow.into())
}

/// Spot and depth for a DLMM pair, from its account and the bin arrays a
/// crank supplied, with every account checked on the way in.
///
/// Both come out of one call, against one borrow of each account, for the
/// same reason the CLMM path reads them in the same instruction: depth for a
/// different moment than the price is depth for a different pool.
#[allow(clippy::too_many_arguments)]
pub fn dlmm_read(
    source: &AccountInfo,
    expected_pair: &Pubkey,
    bin_arrays: &[AccountInfo],
    dec_x: u8,
    dec_y: u8,
    quote_is_x: bool,
    unit_exp: u8,
) -> Result<(u64, u64)> {
    require_keys_eq!(*source.key, *expected_pair, PerpError::WrongOracleFeed);
    let pair = {
        let data = source.try_borrow_data()?;
        parse_dlmm_pair(source.owner, &data)?
    };
    let borrows = bin_arrays
        .iter()
        .map(|a| a.try_borrow_data())
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let arrays = bin_arrays
        .iter()
        .zip(borrows.iter())
        .map(|(a, d)| BinArray::parse(a.owner, d, expected_pair))
        .collect::<Result<Vec<_>>>()?;

    let spot = dlmm_spot_price(&pair, &arrays, dec_x, dec_y, quote_is_x, unit_exp)?;
    let depth = dlmm_depth_usd(&pair, &arrays, dec_x, dec_y, quote_is_x)?;
    Ok((spot, depth))
}

/// Decimals of an SPL mint, after checking it is the one expected and that a
/// token program owns it.
///
/// Both token programs keep `decimals` at byte 44 and `is_initialized` at 45,
/// since Token-2022 extensions only ever append past the base layout.
pub fn mint_decimals(account: &AccountInfo, expected: &Pubkey) -> Result<u8> {
    require_keys_eq!(*account.key, *expected, PerpError::InvalidOracleAccount);
    require!(
        *account.owner == anchor_spl::token::ID || *account.owner == anchor_spl::token_2022::ID,
        PerpError::WrongOracleOwner
    );
    let data = account.try_borrow_data()?;
    require!(data.len() >= 82 && data[45] == 1, PerpError::InvalidOracleAccount);
    Ok(data[44])
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The raw price with its fraction shifted out, as the CLMM tests below
    /// were written against before the unit moved inside the shift.
    fn raw_price_scaled(sqrt_price_x64: u128) -> Result<u128> {
        Ok(clmm_price_num(sqrt_price_x64)? >> CLMM_PRICE_BITS)
    }

    /// Read from the live Raydium SOL/USDC concentrated pool
    /// (3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv). Keeping the real
    /// numbers as the test vector is the point: the offsets in this file are
    /// only worth anything if they were checked against an account the program
    /// will actually be handed.
    const SOL_USDC_SQRT_X64: u128 = 6_082_562_621_452_518_789;
    /// The root as it stands in the cloned fixture, read a little later.
    const SOL_USDC_SQRT_X64_LIVE: u128 = 6_074_887_057_937_055_744;

    #[test]
    fn a_live_pool_parses_to_the_price_it_was_trading_at() {
        let raw = raw_price_scaled(SOL_USDC_SQRT_X64).unwrap();
        let ui = apply_decimals(raw, 9, 6).unwrap();
        // $108.72 at the time it was read. The tolerance is the shift's
        // precision loss, not slack in the layout.
        assert!(
            (108_600_000..=108_800_000).contains(&ui),
            "parsed {ui}, expected ~108_726_000"
        );
    }

    #[test]
    fn inverting_a_pool_recovers_the_other_side() {
        let raw = raw_price_scaled(SOL_USDC_SQRT_X64).unwrap();
        let ui = apply_decimals(raw, 9, 6).unwrap();
        let inverted = (PRICE_SCALE * PRICE_SCALE) / ui;
        // ~0.0092 USDC-denominated SOL, i.e. SOL per dollar.
        assert!((9_100..=9_300).contains(&inverted), "got {inverted}");
    }

    #[test]
    fn decimals_move_the_point_in_both_directions() {
        // Equal decimals leave the raw price alone.
        assert_eq!(apply_decimals(1_000_000, 6, 6).unwrap(), 1_000_000);
        // A 9dp base against a 6dp quote scales up by a thousand.
        assert_eq!(apply_decimals(1_000_000, 9, 6).unwrap(), 1_000_000_000);
        // And the other way.
        assert_eq!(apply_decimals(1_000_000_000, 6, 9).unwrap(), 1_000_000);
    }

    /// From the same cloned account as the price above.
    const SOL_USDC_LIQUIDITY: u128 = 142_311_037_871_991;

    #[test]
    fn depth_reads_what_a_one_percent_move_costs() {
        // Δy = L·Δ√P, with Δ√P taken as half the move in basis points.
        let scaled = (SOL_USDC_LIQUIDITY * SOL_USDC_SQRT_X64_LIVE) >> 64;
        let raw = scaled * (DEPTH_MOVE_BPS / 2) / BPS;
        let depth = to_usd_scale(raw, 6).unwrap();
        // ~$234k to shift a major SOL/USDC concentrated pool one percent,
        // which is the right order of magnitude for one and the check that
        // the liquidity offset is the liquidity offset.
        assert!(
            (200_000_000_000..=270_000_000_000).contains(&depth),
            "got {depth}"
        );
    }

    #[test]
    fn a_thinner_pool_reports_proportionally_less_depth() {
        let deep = (SOL_USDC_LIQUIDITY * SOL_USDC_SQRT_X64_LIVE) >> 64;
        let thin = ((SOL_USDC_LIQUIDITY / 100) * SOL_USDC_SQRT_X64_LIVE) >> 64;
        // Depth is linear in liquidity, so a pool a hundredth the size costs a
        // hundredth as much to move — which is exactly the ratio the
        // confidence interval turns into a spread.
        assert!(deep / thin >= 99 && deep / thin <= 101, "{}", deep / thin);
    }

    #[test]
    fn decimals_are_normalised_in_both_directions() {
        assert_eq!(to_usd_scale(1_000_000_000, 9).unwrap(), 1_000_000);
        assert_eq!(to_usd_scale(1_000_000, 6).unwrap(), 1_000_000);
        assert_eq!(to_usd_scale(1_000, 3).unwrap(), 1_000_000);
    }

    #[test]
    fn a_pool_priced_past_what_can_be_squared_is_refused() {
        // Better a market that will not quote than a mark that wrapped.
        assert!(raw_price_scaled(u128::MAX).is_err());
    }

    #[test]
    fn a_zero_root_is_not_a_price() {
        assert_eq!(raw_price_scaled(0).unwrap(), 0);
    }

    // ------------------------------------------------------------- units

    /// Expected values here were produced by `scripts/pools.ts` from the same
    /// inputs, so these are the check that the two stay bit-identical rather
    /// than merely close.
    #[test]
    fn a_clmm_unit_is_multiplied_in_before_the_shift() {
        let num = clmm_price_num(SOL_USDC_SQRT_X64).unwrap();
        let px = |inv, u| to_usd_price(num, CLMM_PRICE_BITS, 9, 6, inv, u).unwrap();
        assert_eq!(px(false, 0), 108_726_000);
        // Not 108_726_000_000: the unit recovers digits the shift would have
        // dropped, which is the reason it goes in first.
        assert_eq!(px(false, 3), 108_726_080_000);
        assert_eq!(px(false, 6), 108_726_080_573_000);
        // Inverted, the unit multiplies the far side of the division.
        assert_eq!(px(true, 0), 9_197);
        assert_eq!(px(true, 3), 9_197_432);
        assert_eq!(px(true, 6), 9_197_432_076);
    }

    #[test]
    fn a_unit_past_a_billion_is_refused() {
        let num = clmm_price_num(SOL_USDC_SQRT_X64).unwrap();
        assert!(to_usd_price(num, CLMM_PRICE_BITS, 9, 6, false, MAX_UNIT_EXP + 1).is_err());
    }

    #[test]
    fn a_price_too_large_for_the_unit_halts_rather_than_wraps() {
        // A u128 numerator the unit cannot multiply: an error, never a
        // wrapped and plausible-looking mark.
        assert!(to_usd_price(u128::MAX >> 4, 64, 6, 6, false, 9).is_err());
        // And a result past u64 is the same.
        assert!(to_usd_price(u128::MAX >> 40, 0, 6, 6, false, 0).is_err());
    }

    // ------------------------------------------------------ Raydium history

    const SOL_USDC_POOL: Pubkey = pubkey!("3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv");
    /// The pool and its history ring as fetched from mainnet together. The
    /// newest sample (index 77) is at 1790174836; the pool sits at tick -21697.
    const POOL_BYTES: &[u8] =
        include_bytes!("fixtures/3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv.bin");
    const RING_BYTES: &[u8] =
        include_bytes!("fixtures/3Y695CuQ8AP4anbwAqiEBeQF9KxqHFr8piEwvw3UePnQ.bin");
    const RING_LAST_TS: i64 = 1_790_174_836;

    #[test]
    fn a_tick_brackets_the_price_the_pool_actually_stores() {
        let tick = i32::from_le_bytes(POOL_BYTES[269..273].try_into().unwrap());
        let stored = read_u128(POOL_BYTES, off::SQRT_PRICE_X64).unwrap();
        assert_eq!(tick, -21_697);
        assert!(sqrt_price_at_tick(tick).unwrap() <= stored);
        assert!(stored < sqrt_price_at_tick(tick + 1).unwrap());
        assert_eq!(sqrt_price_at_tick(0).unwrap(), 1u128 << 64);
        assert!(sqrt_price_at_tick(MAX_TICK + 1).is_err());
    }

    #[test]
    fn the_ring_averages_the_last_fifteen_minutes() {
        // Worked independently from the same bytes: the first sample at least
        // 900s old is index 28, 903s back, and the average tick over it is
        // -21680, a few ticks above where the pool sits now.
        let now = RING_LAST_TS + 5;
        assert_eq!(ring_twap_tick(RING_BYTES, -21_697, 900, now), Some(-21_680));
    }

    #[test]
    fn a_ring_that_does_not_reach_back_far_enough_says_so() {
        // About 29 minutes of history: enough for fifteen, not for an hour.
        assert!(ring_twap_tick(RING_BYTES, -21_697, 900, RING_LAST_TS).is_some());
        assert_eq!(ring_twap_tick(RING_BYTES, -21_697, 3_600, RING_LAST_TS), None);
    }

    #[test]
    fn a_quiet_pool_carries_its_current_tick_forward() {
        // Ten minutes with no trade: the average leans toward where the pool
        // has sat since, rather than ending at the last sample.
        let later = ring_twap_tick(RING_BYTES, -21_697, 900, RING_LAST_TS + 600).unwrap();
        let fresh = ring_twap_tick(RING_BYTES, -21_697, 900, RING_LAST_TS + 5).unwrap();
        assert!((later - -21_697).abs() < (fresh - -21_697).abs());
    }

    // ------------------------------------------------------ Meteora DLMM

    const BONK_USDC_PAIR: Pubkey = pubkey!("31p1hptjhFo6ZD8oBqkfutNXQKGGPyi7YcEAfsyKW777");
    const BONK: Pubkey = pubkey!("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263");
    const USDC: Pubkey = pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    /// The live pair and its bin array -19, as fetched from mainnet. Active
    /// bin -1277 at step 80, holding Bonk with a stored price of
    /// 3.8097852509551245e-5 raw USDC per raw Bonk.
    const PAIR_BYTES: &[u8] =
        include_bytes!("fixtures/31p1hptjhFo6ZD8oBqkfutNXQKGGPyi7YcEAfsyKW777.bin");
    const ARRAY_BYTES: &[u8] =
        include_bytes!("fixtures/HhCfX3gi8dQFPmVCU4oJoPvmsS1VvDrTNY6zpS4zgSRg.bin");
    const BONK_DEC: u8 = 5;
    const USDC_DEC: u8 = 6;

    fn live() -> (DlmmPair, BinArray<'static>) {
        let pair = parse_dlmm_pair(&METEORA_DLMM_ID, PAIR_BYTES).unwrap();
        let array = BinArray::parse(&METEORA_DLMM_ID, ARRAY_BYTES, &BONK_USDC_PAIR).unwrap();
        (pair, array)
    }

    #[test]
    fn a_live_pair_parses_to_its_active_bin_and_mints() {
        let (pair, array) = live();
        assert_eq!(pair.active_id, -1277);
        assert_eq!(pair.bin_step, 80);
        assert_eq!(pair.mint_x, BONK);
        assert_eq!(pair.mint_y, USDC);
        // Floored, not truncated: -1277 / 70 is -18.24, and the bin is in -19.
        assert_eq!(array.index, -19);
        assert_eq!((-1277i32).div_euclid(BINS_PER_ARRAY), -19);
        assert_eq!(
            array.bin(-1277).unwrap().price,
            702_781_335_001_625,
            "the stored Q64.64 price of the active bin"
        );
        // Array -19 holds bins -1330 to -1261, and nothing either side.
        assert!(array.bin(-1330).is_some() && array.bin(-1261).is_some());
        assert!(array.bin(-1331).is_none() && array.bin(-1260).is_none());
    }

    #[test]
    fn bonk_is_quoted_per_million_with_the_digits_kept() {
        let (pair, array) = live();
        let arrays = [array];
        let px = |u| dlmm_spot_price(&pair, &arrays, BONK_DEC, USDC_DEC, false, u).unwrap();
        // One token at a time, six decimals of dollars cannot hold it.
        assert_eq!(px(0), 3);
        assert_eq!(px(3), 3_809);
        // $3.809785 per million Bonk, the figure `pools.ts` reads.
        assert_eq!(px(6), 3_809_785);
        assert_eq!(px(9), 3_809_785_250);
    }

    #[test]
    fn an_inverted_pair_puts_the_unit_on_the_far_side() {
        // Read as though Bonk were the quote. Meaningless as a market, but it
        // is the orientation a pair listed the other way round takes, and the
        // numbers have to match the mirror's.
        let (pair, array) = live();
        let arrays = [array];
        let px = |u| dlmm_spot_price(&pair, &arrays, BONK_DEC, USDC_DEC, true, u);
        assert_eq!(px(0).unwrap(), 333_333_333_333);
        assert_eq!(px(3).unwrap(), 333_333_333_333_333);
        // Past u64: an error, where the mirror's bigint keeps going.
        assert!(px(9).is_err());
    }

    #[test]
    fn depth_is_the_quote_that_clears_the_bins_a_percent_crosses() {
        let (pair, array) = live();
        let arrays = [array];
        // Step 80 needs two bins for a percent: -1277 and -1276 upward.
        assert_eq!(dlmm_bins_needed(&pair, false).collect::<Vec<_>>(), vec![-1277, -1276]);
        assert_eq!(dlmm_bins_needed(&pair, true).collect::<Vec<_>>(), vec![-1277, -1278]);
        // About $9.4k of Bonk to buy through both, valued at each bin's price.
        assert_eq!(
            dlmm_depth_usd(&pair, &arrays, BONK_DEC, USDC_DEC, false).unwrap(),
            9_457_286_028
        );
        assert_eq!(
            dlmm_depth_usd(&pair, &arrays, BONK_DEC, USDC_DEC, true).unwrap(),
            1_252_284_071_519_230
        );
    }

    #[test]
    fn bins_per_move_rounds_up_and_never_reaches_zero() {
        assert_eq!(dlmm_bins_per_move(80), 2);
        assert_eq!(dlmm_bins_per_move(100), 1);
        assert_eq!(dlmm_bins_per_move(1), 100);
        assert_eq!(dlmm_bins_per_move(250), 1);
        assert_eq!(dlmm_bins_per_move(33), 4);
    }

    #[test]
    fn a_missing_active_bin_halts_and_missing_depth_reads_as_none() {
        let (pair, _) = live();
        // No arrays at all: the price cannot be read, and the depth is zero,
        // which halts the market through its confidence band.
        assert!(dlmm_spot_price(&pair, &[], BONK_DEC, USDC_DEC, false, 6).is_err());
        assert_eq!(dlmm_depth_usd(&pair, &[], BONK_DEC, USDC_DEC, false).unwrap(), 0);
    }

    #[test]
    fn a_bin_array_from_another_pair_is_refused() {
        // The array is real and well-formed; it just is not this pair's.
        assert!(BinArray::parse(&METEORA_DLMM_ID, ARRAY_BYTES, &Pubkey::new_unique()).is_err());
        assert!(BinArray::parse(&RAYDIUM_CLMM_ID, ARRAY_BYTES, &BONK_USDC_PAIR).is_err());
        let mut forged = ARRAY_BYTES.to_vec();
        forged[0] ^= 1;
        assert!(BinArray::parse(&METEORA_DLMM_ID, &forged, &BONK_USDC_PAIR).is_err());
    }

    #[test]
    fn a_pair_is_checked_before_it_is_read() {
        assert!(parse_dlmm_pair(&RAYDIUM_CLMM_ID, PAIR_BYTES).is_err());
        assert!(parse_dlmm_pair(&METEORA_DLMM_ID, &PAIR_BYTES[..100]).is_err());
        // An array is not a pair, whatever it is owned by.
        assert!(parse_dlmm_pair(&METEORA_DLMM_ID, ARRAY_BYTES).is_err());
    }

    // ------------------------------------------------------ pure helpers

    #[test]
    fn every_tick_is_above_the_one_below() {
        // The whole range Raydium allows, not a sample: a TWAP tick turned
        // back into a price must never read lower for a higher tick.
        let mut prev = sqrt_price_at_tick(-MAX_TICK).unwrap();
        for t in (-MAX_TICK + 1)..=MAX_TICK {
            let cur = sqrt_price_at_tick(t).unwrap();
            assert!(cur > prev, "tick {t}: {cur} <= {prev}");
            prev = cur;
        }
    }

    #[test]
    fn ticks_past_the_edge_are_refused_on_both_sides() {
        assert!(sqrt_price_at_tick(-MAX_TICK - 1).is_err());
        assert!(sqrt_price_at_tick(MAX_TICK + 1).is_err());
        // i32::MIN is left out on purpose: `tick.abs()` overflows there and
        // panics instead of erroring. See `sqrt_price_never_panics` in
        // proofs/money.rs.
    }

    #[test]
    fn a_tick_and_its_negative_multiply_to_one() {
        // sqrt(1.0001^t) * sqrt(1.0001^-t) is 1, which in Q64.64 is 2^128.
        // Checked in f64: the two halves are built independently (one by the
        // factor table, one by inverting it), so this ties them together.
        for t in [1, 7, 100, 21_697, 100_000, 443_636] {
            let up = sqrt_price_at_tick(t).unwrap() as f64;
            let down = sqrt_price_at_tick(-t).unwrap() as f64;
            let product = up * down / 2f64.powi(128);
            assert!((product - 1.0).abs() < 1e-9, "tick {t}: {product}");
        }
    }

    #[test]
    fn decimal_gaps_too_wide_to_hold_are_errors_not_panics() {
        // 10^39 does not fit a u128: an error, never a wrap or a panic.
        assert!(apply_decimals(1, 39, 0).is_err());
        assert!(apply_decimals(1, 0, 39).is_err());
        assert!(apply_decimals(u128::MAX, 7, 6).is_err());
        assert!(to_usd_scale(1, 255).is_err());
        assert!(to_usd_scale(u128::MAX, 0).is_err());
    }

    #[test]
    fn scaling_down_rounds_toward_zero() {
        // A 9dp amount a hair under a micro-dollar reads as zero, not one.
        assert_eq!(to_usd_scale(999, 9).unwrap(), 0);
        assert_eq!(apply_decimals(999, 6, 9).unwrap(), 0);
    }
}
