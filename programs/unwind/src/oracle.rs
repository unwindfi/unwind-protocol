//! Reading Pyth's `PriceUpdateV2` push-oracle accounts.
//!
//! The account is read directly rather than through `pyth-solana-receiver-sdk`,
//! which at the time of writing pins `pythnet-sdk` 2.x and therefore `borsh`
//! 0.10, and cannot be linked against an Anchor 0.31 program (which is on
//! `borsh` 1.x). The layout mirrored below is Pyth's, and the checks the SDK
//! performs -- program ownership, account discriminator, `Full` Wormhole
//! verification, matching feed id, and staleness -- are all reproduced here.

use crate::constants::*;
use crate::errors::PerpError;
use anchor_lang::prelude::*;

/// Pyth's Solana Receiver on mainnet and devnet. The default a pool is created
/// with; a cluster without it — or a test one — records its own in
/// `Pool::pyth_receiver`. The ownership check itself is not optional: without
/// it anyone could hand the program a fabricated price.
pub const PYTH_RECEIVER_ID: Pubkey = pubkey!("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");

/// sha256("account:PriceUpdateV2")[..8]
pub const PRICE_UPDATE_V2_DISCRIMINATOR: [u8; 8] = [34, 241, 35, 99, 157, 126, 244, 205];

/// How much of the Wormhole guardian set has signed off on an update.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum VerificationLevel {
    Partial { num_signatures: u8 },
    Full,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct PriceFeedMessage {
    pub feed_id: [u8; 32],
    pub price: i64,
    pub conf: u64,
    pub exponent: i32,
    pub publish_time: i64,
    pub prev_publish_time: i64,
    pub ema_price: i64,
    pub ema_conf: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct PriceUpdateV2 {
    pub write_authority: Pubkey,
    pub verification_level: VerificationLevel,
    pub price_message: PriceFeedMessage,
    pub posted_slot: u64,
}

/// An oracle reading normalised to `PRICE_SCALE`, with its confidence interval
/// preserved. Confidence is not decoration here: for a tokenized equity it is
/// the best available signal of whether the underlying is liquid right now, and
/// it drives both the spread and the halt condition.
#[derive(Clone, Copy, Debug)]
pub struct OraclePrice {
    pub price: u64,
    pub conf: u64,
    pub published_ts: i64,
}

impl OraclePrice {
    /// Confidence as a fraction of price, in basis points.
    pub fn conf_bps(&self) -> Result<u64> {
        require!(self.price > 0, PerpError::InvalidOraclePrice);
        // Saturates rather than wrapping: a confidence wide enough to pass
        // u64 in bps is as wide as it gets, and must not read as narrow.
        Ok(u64::try_from((self.conf as u128) * BPS / (self.price as u128)).unwrap_or(u64::MAX))
    }
}

/// Loads and validates a `PriceUpdateV2` account.
pub fn load_price_update(account: &AccountInfo, receiver: &Pubkey) -> Result<PriceUpdateV2> {
    require_keys_eq!(*account.owner, *receiver, PerpError::WrongOracleOwner);
    let data = account.try_borrow_data()?;
    require!(data.len() > 8, PerpError::InvalidOracleAccount);
    require!(
        data[..8] == PRICE_UPDATE_V2_DISCRIMINATOR,
        PerpError::InvalidOracleAccount
    );
    let mut slice: &[u8] = &data[8..];
    PriceUpdateV2::deserialize(&mut slice).map_err(|_| PerpError::InvalidOracleAccount.into())
}

/// Reads a price, checks it against the market's limits, and rescales it to
/// `PRICE_SCALE`.
///
/// Partially verified updates are rejected outright. They only require a subset
/// of Wormhole guardians to sign, which is an unacceptable trust assumption for
/// an account that decides liquidations.
pub fn read_price(
    account: &AccountInfo,
    receiver: &Pubkey,
    feed_id: &[u8; 32],
    max_age_sec: u32,
    max_conf_bps: u16,
) -> Result<OraclePrice> {
    let update = load_price_update(account, receiver)?;
    require!(
        update.verification_level == VerificationLevel::Full,
        PerpError::InsufficientOracleVerification
    );
    let msg = update.price_message;
    require!(msg.feed_id == *feed_id, PerpError::WrongOracleFeed);

    let clock = Clock::get()?;
    require!(
        msg.publish_time.saturating_add(max_age_sec as i64) >= clock.unix_timestamp,
        PerpError::StaleOracle
    );
    require!(msg.price > 0, PerpError::InvalidOraclePrice);

    let out = rescale(msg.price, msg.conf, msg.exponent, msg.publish_time)?;
    require!(
        out.conf_bps()? <= max_conf_bps as u64,
        PerpError::OracleConfidenceTooWide
    );
    Ok(out)
}

/// Reads a mark from an `Observation` account, for assets Pyth does not cover.
///
/// Deliberately the same return type and the same checks as the Pyth path —
/// staleness, positive price, confidence against the market's ceiling — so
/// nothing downstream knows or cares which kind of market it is pricing. A
/// memecoin with a thin pool halts through exactly the mechanism a tokenized
/// equity halts through at 3am: a confidence interval too wide to quote into.
///
/// The extra check is seasoning. A Pyth feed arrives with its history already
/// behind it; an observed mark has to build one, and until it has, this is an
/// asset that can be listed and cranked but not traded.
pub fn read_observed_price(
    observation: &crate::state::Observation,
    market_key: &Pubkey,
    max_age_sec: u32,
    max_conf_bps: u16,
    conf_reference_bps: u16,
) -> Result<OraclePrice> {
    require_keys_eq!(observation.market, *market_key, PerpError::WrongOracleFeed);
    require!(observation.is_seasoned(), PerpError::OracleNotSeasoned);

    let clock = Clock::get()?;
    require!(
        observation
            .last_update_ts
            .saturating_add(max_age_sec as i64)
            >= clock.unix_timestamp,
        PerpError::StaleOracle
    );
    require!(observation.ewma_price > 0, PerpError::InvalidOraclePrice);

    let out = OraclePrice {
        price: observation.ewma_price,
        conf: observation.conf_usd(conf_reference_bps)?,
        published_ts: observation.last_update_ts,
    };
    require!(
        out.conf_bps()? <= max_conf_bps as u64,
        PerpError::OracleConfidenceTooWide
    );
    Ok(out)
}

/// Rescales a Pyth price from the feed's own exponent to `PRICE_SCALE`.
///
/// Feeds do not share an exponent, so this has to shift in both directions
/// rather than assume a fixed one.
pub(crate) fn rescale(price: i64, conf: u64, exponent: i32, published_ts: i64) -> Result<OraclePrice> {
    let raw = price as u128;
    let conf_raw = conf as u128;
    let target_exp: i32 = -6; // PRICE_SCALE = 1e6

    let (scaled, conf_scaled) = if exponent >= target_exp {
        let shift = 10u128
            .checked_pow(u32::try_from(exponent - target_exp).map_err(|_| PerpError::MathOverflow)?)
            .ok_or(PerpError::MathOverflow)?;
        (
            raw.checked_mul(shift).ok_or(PerpError::MathOverflow)?,
            conf_raw.checked_mul(shift).ok_or(PerpError::MathOverflow)?,
        )
    } else {
        let shift = 10u128
            .checked_pow(u32::try_from(target_exp - exponent).map_err(|_| PerpError::MathOverflow)?)
            .ok_or(PerpError::MathOverflow)?;
        (raw / shift, conf_raw / shift)
    };

    let out = OraclePrice {
        price: u64::try_from(scaled).map_err(|_| PerpError::MathOverflow)?,
        conf: u64::try_from(conf_scaled).map_err(|_| PerpError::MathOverflow)?,
        published_ts,
    };
    require!(out.price > 0, PerpError::InvalidOraclePrice);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rescales_an_eight_decimal_feed_down_to_six() {
        // Pyth equity feeds publish at exponent -8: 190.12345678 -> $190.123456
        let p = rescale(19_012_345_678, 1_000_000, -8, 0).unwrap();
        assert_eq!(p.price, 190_123_456);
        assert_eq!(p.conf, 10_000);
    }

    #[test]
    fn rescales_a_coarser_feed_up_to_six() {
        // exponent -2: 190.12 -> $190.120000
        let p = rescale(19_012, 5, -2, 0).unwrap();
        assert_eq!(p.price, 190_120_000);
        assert_eq!(p.conf, 50_000);
    }

    #[test]
    fn confidence_is_expressed_in_bps_of_price() {
        let p = OraclePrice {
            price: 100_000_000,
            conf: 500_000,
            published_ts: 0,
        };
        assert_eq!(p.conf_bps().unwrap(), 50);
    }

    #[test]
    fn a_reading_too_large_for_the_scale_is_refused_not_wrapped() {
        // i64::MAX at exponent 0 is 9.2e24 at six decimals, past a u64.
        assert!(rescale(i64::MAX, 0, 0, 0).is_err());
        // A confidence that overflows is refused as well, even if the price fits.
        assert!(rescale(1, u64::MAX, 0, 0).is_err());
        // An exponent whose power of ten does not fit a u128.
        assert!(rescale(1, 0, 40, 0).is_err());
    }

    #[test]
    fn a_price_that_rounds_to_zero_is_refused() {
        // 99e-8 is $0.00000099, which is zero at six decimals.
        assert!(rescale(99, 0, -8, 0).is_err());
        assert_eq!(rescale(100, 0, -8, 0).unwrap().price, 1);
        assert!(rescale(i64::MAX, 0, -60, 0).is_err());
    }

    #[test]
    fn scaling_down_truncates_and_never_rounds_up() {
        let p = rescale(19_999_999, 999, -8, 0).unwrap();
        assert_eq!(p.price, 199_999);
        assert_eq!(p.conf, 9);
    }

    // Found while writing the Kani proofs of `conf_bps`: the ratio was
    // computed in u128 and narrowed with `as u64`, which wrapped, so a
    // confidence ~1.8e15 times the price read 8,384 bps and passed a
    // `max_conf_bps` check that a confidence equal to the price fails. It
    // saturates now.
    #[test]
    fn a_wider_confidence_never_reads_as_narrower() {
        let at_price = OraclePrice { price: 1, conf: 1, published_ts: 0 };
        let absurd = OraclePrice { price: 1, conf: 1_844_674_407_370_956, published_ts: 0 };
        assert!(absurd.conf_bps().unwrap() >= at_price.conf_bps().unwrap());
    }


    /// Bytes of a real `PriceUpdateV2` account, fetched from Solana devnet and
    /// owned by Pyth's own receiver program. Feed `ef0d8b6f…` is SOL/USD.
    ///
    /// The point of this test is the abstraction the localnet oracle rests on:
    /// `mock-pyth` writes accounts in this layout so that pointing the program
    /// at the real receiver is a change of address, not of code. Parsing the
    /// real thing is the only way to know that holds.
    const REAL_DEVNET_ACCOUNT: &str = "IvEjY51+9M3eCjrdOHe3JwHpJGT50AGgyv4tF5TVDc11W4u4dPpIBQHvDYtv2izrpB2hXUCV0do5Kg0vjtDGx7wPTPrIwoC1baINgvYBAAAAEEhyAAAAAAD4////0jgRagAAAADSOBFqAAAAAAQ4EfcBAAAA2h2BAAAAAACfgawbAAAAAAA=";

    fn decode_base64(s: &str) -> Vec<u8> {
        const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = Vec::new();
        let (mut acc, mut bits) = (0u32, 0u32);
        for c in s.bytes().filter(|c| *c != b'=' && !c.is_ascii_whitespace()) {
            let v = T.iter().position(|t| *t == c).expect("base64") as u32;
            acc = (acc << 6) | v;
            bits += 6;
            if bits >= 8 {
                bits -= 8;
                out.push((acc >> bits) as u8);
            }
        }
        out
    }

    #[test]
    fn parses_a_real_pyth_account_from_devnet() {
        let data = decode_base64(REAL_DEVNET_ACCOUNT);
        assert_eq!(&data[..8], PRICE_UPDATE_V2_DISCRIMINATOR);

        let update = PriceUpdateV2::deserialize(&mut &data[8..]).expect("real account parses");
        assert_eq!(update.verification_level, VerificationLevel::Full);
        assert_eq!(
            hex32(&update.price_message.feed_id),
            "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d"
        );
        assert!(update.price_message.price > 0);
        assert_eq!(update.price_message.exponent, -8);

        // And it survives the rescale the program actually uses.
        let p = rescale(
            update.price_message.price,
            update.price_message.conf,
            update.price_message.exponent,
            update.price_message.publish_time,
        )
        .unwrap();
        assert!(p.price > 0);
        assert!(p.conf_bps().unwrap() < 10_000, "a real quote is inside 100%");
    }

    #[test]
    fn a_full_verification_account_carries_a_trailing_byte() {
        // Pyth sizes the account for the wider `Partial { num_signatures }`
        // variant, so a `Full` update leaves one byte spare. The reader must
        // use `deserialize`, which stops when the struct is complete, rather
        // than `try_from_slice`, which treats the spare byte as corruption.
        let data = decode_base64(REAL_DEVNET_ACCOUNT);
        assert_eq!(data.len(), 134, "Pyth's account is sized for Partial");

        let body = &data[8..];
        assert!(PriceUpdateV2::deserialize(&mut &body[..]).is_ok());
        assert!(
            PriceUpdateV2::try_from_slice(body).is_err(),
            "try_from_slice would reject the real account"
        );
    }

    fn hex32(b: &[u8; 32]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    #[test]
    fn layout_matches_pyths_account_size() {
        // 32 write_authority + 2 verification_level + 32 feed_id + 8 price
        // + 8 conf + 4 exponent + 8 publish + 8 prev_publish + 8 ema_price
        // + 8 ema_conf + 8 posted_slot, plus the 8-byte discriminator.
        let update = PriceUpdateV2 {
            write_authority: Pubkey::default(),
            verification_level: VerificationLevel::Full,
            price_message: PriceFeedMessage {
                feed_id: [7; 32],
                price: 1,
                conf: 2,
                exponent: -8,
                publish_time: 3,
                prev_publish_time: 4,
                ema_price: 5,
                ema_conf: 6,
            },
            posted_slot: 9,
        };
        // 32 authority + 1 (`Full` is a unit variant, so 1 byte not 2)
        // + 84 price_message + 8 posted_slot. The discriminator is not part of
        // the borsh body, so Pyth's LEN of 8 + 32 + 2 + 116 is this plus the
        // discriminator and the wider `Partial` tag.
        assert_eq!(update.try_to_vec().unwrap().len(), 32 + 1 + 84 + 8);

        let partial = VerificationLevel::Partial { num_signatures: 3 };
        assert_eq!(partial.try_to_vec().unwrap().len(), 2);
    }

    #[test]
    fn round_trips_through_borsh() {
        let update = PriceUpdateV2 {
            write_authority: Pubkey::new_unique(),
            verification_level: VerificationLevel::Partial { num_signatures: 5 },
            price_message: PriceFeedMessage {
                feed_id: [3; 32],
                price: 19_012_345_678,
                conf: 1_234,
                exponent: -8,
                publish_time: 1_700_000_000,
                prev_publish_time: 1_699_999_999,
                ema_price: 19_000_000_000,
                ema_conf: 2_000,
            },
            posted_slot: 42,
        };
        let bytes = update.try_to_vec().unwrap();
        let back = PriceUpdateV2::deserialize(&mut bytes.as_slice()).unwrap();
        assert_eq!(back.price_message.price, 19_012_345_678);
        assert_eq!(back.price_message.feed_id, [3; 32]);
        assert_eq!(
            back.verification_level,
            VerificationLevel::Partial { num_signatures: 5 }
        );
    }
}
