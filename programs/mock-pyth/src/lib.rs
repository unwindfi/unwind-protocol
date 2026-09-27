//! A localnet stand-in for the Pyth Solana Receiver.
//!
//! `solana-test-validator` will only accept accounts owned by a program that
//! exists at boot, and nothing can sign as the real receiver, so the product
//! used to ship a pre-generated ladder of `PriceUpdateV2` fixtures and walk it.
//! That ladder is what made the price synthetic: it quantised to 0.25% rungs,
//! it was capped at +/-20% of a hardcoded base, and its `publish_time` was
//! frozen at generation, which forced `max_price_age_sec` up to a day.
//!
//! This program is deployed *at the receiver's address* on localnet
//! (`--bpf-program rec5EK...`), so the accounts it owns are indistinguishable
//! to `unwind::oracle` from the real thing. The server posts whatever the
//! live source says, at its real timestamp. Nothing in the perps program is
//! relaxed to accommodate it: ownership, discriminator, `Full` verification,
//! feed id and staleness are all still checked, and all still have to pass.
//!
//! On localnet it is a fixture. On the devnet testnet it is the price relay:
//! real market prices, posted by our server, because Pyth's own price updates
//! now need a paid API key (Starter is crypto only; equities need Pro). Built
//! with the `devnet` feature, only `RELAY_AUTHORITY` may post, so nobody else
//! can move a market's price. Mainnet uses the real receiver, and this program
//! is not deployed there.
use anchor_lang::prelude::*;

declare_id!("J1FKStdEnsAK69gV4G5nVTm6eZTquo5kwQdLCHctE2k4");

/// The only key that may post prices on the devnet testnet: the server's
/// relay key, kept apart from the program's upgrade authority so the machine
/// running the crank never holds the key that can change programs.
#[cfg(feature = "devnet")]
pub const RELAY_AUTHORITY: Pubkey = pubkey!("78DsUWZgfkFe54NvRzScYsWS9G1niz2oZi2KaNDiQbzL");

/// How much of the Wormhole guardian set has signed off on an update. Mirrors
/// the receiver's own enum; `Partial` exists so the layout is faithful, and so
/// tests can post an update the perps program is expected to reject.
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

/// Named to match Pyth exactly: Anchor derives the discriminator as
/// `sha256("account:PriceUpdateV2")[..8]`, which is the same eight bytes the
/// receiver writes and `unwind::oracle` checks for. Renaming this struct
/// would silently break every oracle read.
#[account]
pub struct PriceUpdateV2 {
    pub write_authority: Pubkey,
    pub verification_level: VerificationLevel,
    pub price_message: PriceFeedMessage,
    pub posted_slot: u64,
}

impl PriceUpdateV2 {
    /// 8 discriminator + 32 authority + 2 verification level (sized for the
    /// wider `Partial` tag) + 84 price message + 8 posted slot.
    pub const LEN: usize = 8 + 32 + 2 + 84 + 8;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct PostPriceArgs {
    pub feed_id: [u8; 32],
    pub price: i64,
    pub conf: u64,
    pub exponent: i32,
    /// The source's own timestamp, not the validator's clock. Posting the real
    /// one is what makes the perps program's staleness check mean something.
    pub publish_time: i64,
    /// `false` posts a `Partial` update, which the perps program must reject.
    pub fully_verified: bool,
}

#[error_code]
pub enum MockPythError {
    #[msg("price must be positive")]
    InvalidPrice,
    #[msg("publish time must not go backwards")]
    PublishTimeRegressed,
    #[msg("only the relay authority may post prices")]
    NotRelayAuthority,
}

#[program]
pub mod mock_pyth {
    use super::*;

    /// Creates or overwrites the feed's price account.
    ///
    /// One account per feed id, reused every tick, so the address a market
    /// trades against is stable for the life of the validator -- unlike the
    /// ladder, where every price change meant a different account.
    pub fn post_price(ctx: Context<PostPrice>, args: PostPriceArgs) -> Result<()> {
        // Without this, anyone could post any price for any feed and trade
        // against it. Open on localnet, where the tests post their own.
        #[cfg(feature = "devnet")]
        require_keys_eq!(ctx.accounts.payer.key(), RELAY_AUTHORITY, MockPythError::NotRelayAuthority);
        require!(args.price > 0, MockPythError::InvalidPrice);

        let update = &mut ctx.accounts.price_update;
        // Zero on the first post, since the account is fresh.
        let prev = update.price_message.publish_time;
        require!(args.publish_time >= prev, MockPythError::PublishTimeRegressed);

        update.write_authority = ctx.accounts.payer.key();
        update.verification_level = if args.fully_verified {
            VerificationLevel::Full
        } else {
            VerificationLevel::Partial { num_signatures: 3 }
        };
        update.price_message = PriceFeedMessage {
            feed_id: args.feed_id,
            price: args.price,
            conf: args.conf,
            exponent: args.exponent,
            publish_time: args.publish_time,
            prev_publish_time: prev,
            // The perps program reads neither, and the live source publishes
            // no EMA, so inventing one would be worse than mirroring the spot.
            ema_price: args.price,
            ema_conf: args.conf,
        };
        update.posted_slot = Clock::get()?.slot;
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(args: PostPriceArgs)]
pub struct PostPrice<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        space = PriceUpdateV2::LEN,
        seeds = [b"price", args.feed_id.as_ref()],
        bump,
    )]
    pub price_update: Account<'info, PriceUpdateV2>,
    pub system_program: Program<'info, System>,
}
