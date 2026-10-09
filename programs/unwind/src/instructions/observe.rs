use crate::amm::{
    check_clmm_pool, clmm_depth_usd, clmm_spot_price, clmm_twap_price, dlmm_read, mint_decimals,
    parse_dlmm_pair, MAX_UNIT_EXP,
};
use crate::constants::*;
use crate::errors::PerpError;
use crate::state::*;
use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ObservationParams {
    /// The AMM pool to read. Fixed here and checked on every crank, so a
    /// market cannot be quietly repointed at a pool someone just created.
    pub source: Pubkey,
    pub source_kind: u8,
    /// True when the stablecoin is the pool's token 0 and readings need
    /// inverting. An accident of how the two mint addresses sort, so it has to
    /// be recorded rather than assumed.
    pub quote_is_token_0: bool,
    pub alpha_bps: u16,
    pub max_move_bps: u16,
    /// Quote the mark per `10^unit_exp` tokens, at most `MAX_UNIT_EXP`. See
    /// `Observation::unit_exp`; the lister picks it so the mark keeps its
    /// significant figures, and the program only bounds it.
    pub unit_exp: u8,
}

#[derive(Accounts)]
pub struct CreateObservation<'info> {
    /// The market's lister, and nobody else. The observation's parameters
    /// (fold rate, clamp, unit) are fixed for the market's life, so a
    /// stranger who created it first, between the listing and the lister's
    /// own call, would have chosen them.
    #[account(mut, address = market.deployer @ PerpError::NotMarketDeployer)]
    pub payer: Signer<'info>,

    #[account(seeds = [POOL_SEED, pool.usdc_mint.as_ref()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,

    #[account(has_one = pool @ PerpError::MarketPoolMismatch)]
    pub market: Box<Account<'info, Market>>,

    #[account(
        init,
        payer = payer,
        space = 8 + Observation::INIT_SPACE,
        seeds = [OBSERVATION_SEED, market.key().as_ref()],
        bump,
    )]
    pub observation: Box<Account<'info, Observation>>,

    /// CHECK: must be `params.source`, owned by the AMM `params.source_kind`
    /// names and carrying its discriminator; checked in the handler. Read
    /// here so a market pointed at the wrong account fails at listing
    /// instead of on its first crank, after the lister has paid for it.
    pub source: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

/// Starts observing a pool for a market Pyth does not cover.
///
/// Only the market's lister may call it, and it is deliberately harmless:
/// creating this account begins a clock and nothing else. The mark it builds cannot be traded against until
/// it is seasoned, so the cost of someone pointing a market at a bad pool is
/// that the market never opens, not that it opens wrongly.
///
/// A Raydium pool that has been trading for a while has already done the
/// watching, and keeps the record on chain. Pass its history ring as the
/// first remaining account and the mark starts seasoned, at the pool's own
/// fifteen-minute average, provided the ring reaches back that far and the
/// spot has not wandered from it (`SEED_MAX_GAP_BPS`). Otherwise, or without
/// the ring, the market seasons the ordinary way.
/// The feed id an observed market must carry: `sha256("amm:" || pool)`,
/// over the pool's raw address. Also computed off-chain by whoever lists.
pub fn observed_feed_id(pool: &Pubkey) -> [u8; 32] {
    anchor_lang::solana_program::hash::hashv(&[b"amm:", pool.as_ref()]).to_bytes()
}

pub fn create_observation(
    ctx: Context<CreateObservation>,
    params: ObservationParams,
) -> Result<()> {
    check_observation_params(params.alpha_bps, params.max_move_bps, params.unit_exp)?;

    let source = &ctx.accounts.source;
    require_keys_eq!(*source.key, params.source, PerpError::WrongOracleFeed);
    // The market's address is derived from its feed id, and anyone may list.
    // Tying an observed market's id to the pool it reads means an AMM-priced
    // market can only ever sit at that pool's own address, never at the one a
    // Pyth feed would claim.
    let market = &ctx.accounts.market;
    require!(
        market.price_source == PriceSource::Observed as u8
            && market.feed_id == observed_feed_id(&params.source),
        PerpError::ObservedFeedMismatch
    );
    let (dec_x, dec_y) = match SourceKind::from_u8(params.source_kind)? {
        SourceKind::RaydiumClmm => {
            let data = source.try_borrow_data()?;
            check_clmm_pool(source.owner, &data)?;
            let mint = |at: usize| Pubkey::new_from_array(data[at..at + 32].try_into().unwrap());
            check_quote_side(
                &mint(CLMM_MINT_0),
                &mint(CLMM_MINT_1),
                params.quote_is_token_0,
                &ctx.accounts.pool.usdc_mint,
            )?;
            (0, 0)
        }
        SourceKind::MeteoraDlmm => {
            // The pair has no decimals of its own, so the lister passes both
            // mints and they are read once, here. Checking each against the
            // pair's own record of its mints is what stops a lister passing a
            // mint with convenient decimals and shifting the mark by powers
            // of ten.
            let pair = parse_dlmm_pair(source.owner, &source.try_borrow_data()?)?;
            check_quote_side(
                &pair.mint_x,
                &pair.mint_y,
                params.quote_is_token_0,
                &ctx.accounts.pool.usdc_mint,
            )?;
            require!(ctx.remaining_accounts.len() >= 2, PerpError::InvalidOracleAccount);
            (
                mint_decimals(&ctx.remaining_accounts[0], &pair.mint_x)?,
                mint_decimals(&ctx.remaining_accounts[1], &pair.mint_y)?,
            )
        }
        SourceKind::OrcaWhirlpool => return err!(PerpError::InvalidOracleAccount),
    };

    let o = &mut ctx.accounts.observation;
    o.bump = ctx.bumps.observation;
    o.market = ctx.accounts.market.key();
    o.source = params.source;
    o.source_kind = params.source_kind;
    o.quote_is_token_0 = params.quote_is_token_0;
    o.alpha_bps = params.alpha_bps;
    o.max_move_bps = params.max_move_bps;
    o.ewma_price = 0;
    o.last_spot = 0;
    o.observations = 0;
    o.first_update_ts = 0;
    o.last_update_ts = 0;
    o.depth_usd = 0;
    o.dec_x = dec_x;
    o.dec_y = dec_y;
    o.unit_exp = params.unit_exp;

    if SourceKind::from_u8(params.source_kind)? == SourceKind::RaydiumClmm {
        if let Some(history) = ctx.remaining_accounts.first() {
            seed_from_history(o, source, history)?;
        }
    }
    Ok(())
}

/// Where a Raydium pool account keeps its two mints (`token_mint_0`,
/// `token_mint_1`), as `scripts/pools.ts` reads them.
const CLMM_MINT_0: usize = 73;
const CLMM_MINT_1: usize = 105;

/// Stablecoins a tracked pool may be quoted in besides the one this pool
/// settles in: mainnet USDC and USDT, mirroring `QUOTE_MINTS` in
/// scripts/listing-policy.ts.
pub const QUOTE_MINTS: [Pubkey; 2] = [
    pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
    pubkey!("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"),
];

/// Circle's devnet USDC. Real tokens' devnet pools are quoted in it, not in
/// the test USDC a devnet pool settles in, so without it no existing devnet
/// token could be listed, only ones somebody minted against the test mint.
/// A dollar like the others for pricing; accepted on devnet builds only.
#[cfg(feature = "devnet")]
pub const DEVNET_QUOTE_MINTS: [Pubkey; 1] = [pubkey!("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU")];
#[cfg(not(feature = "devnet"))]
pub const DEVNET_QUOTE_MINTS: [Pubkey; 0] = [];

/// The side `quote_is_token_0` names must be a dollar. Every reading counts
/// the quote token as a dollar at its own decimals, so a pool quoted in a
/// token the lister minted would give the market whatever depth, confidence
/// and leverage tier they liked, and a lister who flipped the flag would
/// mark the market upside down.
pub fn check_quote_side(
    mint_0: &Pubkey,
    mint_1: &Pubkey,
    quote_is_token_0: bool,
    settle_mint: &Pubkey,
) -> Result<()> {
    let quote = if quote_is_token_0 { mint_0 } else { mint_1 };
    require!(
        quote == settle_mint || QUOTE_MINTS.contains(quote) || DEVNET_QUOTE_MINTS.contains(quote),
        PerpError::InvalidOracleAccount
    );
    Ok(())
}

/// The fold weight, clamp and unit a lister may give an observation.
pub fn check_observation_params(alpha_bps: u16, max_move_bps: u16, unit_exp: u8) -> Result<()> {
    require!(alpha_bps > 0 && alpha_bps <= MAX_ALPHA_BPS, PerpError::InvalidParameter);
    require!(max_move_bps > 0 && max_move_bps <= MAX_MOVE_BPS, PerpError::InvalidParameter);
    require!(unit_exp <= MAX_UNIT_EXP, PerpError::InvalidParameter);
    Ok(())
}

/// Starts a mark seasoned, from the pool's own recorded average. See
/// `create_observation`. Declining is not an error: a pool whose history is
/// too short, or whose spot has moved off it, simply seasons the slow way.
fn seed_from_history(
    o: &mut Observation,
    source: &AccountInfo,
    history: &AccountInfo,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let twap = match clmm_twap_price(
        source,
        &o.source,
        history,
        o.quote_is_token_0,
        o.unit_exp,
        MIN_OBSERVATION_WINDOW_SEC,
        now,
    )? {
        Some(p) if p > 0 => p,
        _ => return Ok(()),
    };
    let spot = clmm_spot_price(source, &o.source, o.quote_is_token_0, o.unit_exp)?;
    let gap = (spot as i128 - twap as i128).unsigned_abs();
    if gap * BPS > (twap as u128) * SEED_MAX_GAP_BPS {
        return Ok(());
    }

    o.ewma_price = twap;
    o.last_spot = spot;
    o.depth_usd = clmm_depth_usd(source, &o.source, o.quote_is_token_0)?;
    o.budget_depth_usd = o.depth_usd;
    // Exactly the bar `is_seasoned` sets, met by the pool's record rather
    // than by our own readings. The crank folds on from here as it would for
    // any market.
    o.observations = MIN_OBSERVATIONS;
    o.first_update_ts = now - MIN_OBSERVATION_WINDOW_SEC;
    o.last_update_ts = now;

    emit!(MarkSeeded { market: o.market, twap, spot });
    Ok(())
}

/// A mark that started seasoned, from the pool's own history.
#[event]
pub struct MarkSeeded {
    pub market: Pubkey,
    /// The pool's fifteen-minute average it opened at.
    pub twap: u64,
    pub spot: u64,
}

#[derive(Accounts)]
pub struct Observe<'info> {
    #[account(
        mut,
        seeds = [OBSERVATION_SEED, observation.market.as_ref()],
        bump = observation.bump,
    )]
    pub observation: Box<Account<'info, Observation>>,

    /// Written with the leverage its pool's sustained depth supports, so every
    /// reading that thins the pool lowers it before the next order lands.
    #[account(mut, address = observation.market @ PerpError::WrongOracleFeed)]
    pub market: Box<Account<'info, Market>>,

    /// CHECK: validated by the reader for `observation.source_kind`: owner,
    /// discriminator, and that it is the pool this observation was created
    /// against. A DLMM pair's bin arrays follow in `remaining_accounts` and
    /// are checked the same way, plus that each belongs to this pair.
    pub source: AccountInfo<'info>,
}

/// Folds one reading of the pool into the mark.
///
/// Permissionless and cheap on purpose. The mark's resistance to manipulation
/// comes from being observed often over a long window, so anything that makes
/// cranking expensive or privileged makes the mark worse. There is no reward
/// attached: the parties who want this cranked are the ones with positions
/// against it, and the deployer earning fees on the market.
pub fn observe(ctx: Context<Observe>) -> Result<()> {
    let o = &mut ctx.accounts.observation;

    // Depth is read on every crank, from the same account, in the same
    // transaction as the price it belongs to. Depth measured at a different
    // moment than the price is depth for a different pool.
    let (spot, depth) = match SourceKind::from_u8(o.source_kind)? {
        SourceKind::RaydiumClmm => (
            clmm_spot_price(&ctx.accounts.source, &o.source, o.quote_is_token_0, o.unit_exp)?,
            clmm_depth_usd(&ctx.accounts.source, &o.source, o.quote_is_token_0)?,
        ),
        SourceKind::MeteoraDlmm => dlmm_read(
            &ctx.accounts.source,
            &o.source,
            ctx.remaining_accounts,
            o.dec_x,
            o.dec_y,
            o.quote_is_token_0,
            o.unit_exp,
        )?,
        SourceKind::OrcaWhirlpool => return err!(PerpError::InvalidOracleAccount),
    };
    o.depth_usd = depth;
    let now = Clock::get()?.unix_timestamp;
    o.track_depth(depth, now);
    ctx.accounts.market.depth_leverage_x = leverage_for_depth(o.sustained_depth_usd);
    // A keeper-priced mark is the keeper's to move. The pool is still read,
    // for the depth above, but folding its spot in here would put a price
    // anyone can move for one transaction back into a mark that exists to
    // keep it out, and refreshing `last_update_ts` would hide a keeper that
    // has stopped.
    if o.keeper_priced {
        o.last_spot = spot;
        return Ok(());
    }
    let before = o.ewma_price;
    if !o.fold(spot, now)? {
        // Already read this second; the depth above still counts.
        return Ok(());
    }

    emit!(MarkObserved {
        market: o.market,
        spot,
        mark: o.ewma_price,
        // A reading the clamp had to hold back is the shape manipulation takes
        // while it is happening, so it is worth emitting rather than inferring.
        clamped: before > 0 && o.ewma_price != folded_unclamped(before, spot, o.alpha_bps),
        observations: o.observations,
    });
    Ok(())
}

/// What the fold would have produced without the clamp — for the event only.
fn folded_unclamped(prev: u64, spot: u64, alpha_bps: u16) -> u64 {
    let a = alpha_bps as u128;
    (((prev as u128) * (BPS - a) + (spot as u128) * a) / BPS) as u64
}

#[event]
pub struct MarkObserved {
    pub market: Pubkey,
    pub spot: u64,
    pub mark: u64,
    pub clamped: bool,
    pub observations: u32,
}

#[derive(Accounts)]
pub struct SetMarkKeeper<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [POOL_SEED, pool.usdc_mint.as_ref()],
        bump = pool.bump,
        has_one = authority @ PerpError::Unauthorized,
    )]
    pub pool: Box<Account<'info, Pool>>,

    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + MarkKeeper::INIT_SPACE,
        seeds = [MARK_KEEPER_SEED, pool.key().as_ref()],
        bump,
    )]
    pub mark_keeper: Box<Account<'info, MarkKeeper>>,

    pub system_program: Program<'info, System>,
}

/// Names the key whose pushed prices are the marks of keeper-priced markets.
/// Pass `Pubkey::default()` to stop all pushes.
pub fn set_mark_keeper(ctx: Context<SetMarkKeeper>, keeper: Pubkey) -> Result<()> {
    let k = &mut ctx.accounts.mark_keeper;
    k.bump = ctx.bumps.mark_keeper;
    k.pool = ctx.accounts.pool.key();
    k.keeper = keeper;
    emit!(MarkKeeperSet { pool: k.pool, keeper });
    Ok(())
}

#[event]
pub struct MarkKeeperSet {
    pub pool: Pubkey,
    pub keeper: Pubkey,
}

#[derive(Accounts)]
pub struct PushMark<'info> {
    pub keeper: Signer<'info>,

    #[account(
        mut,
        seeds = [OBSERVATION_SEED, observation.market.as_ref()],
        bump = observation.bump,
    )]
    pub observation: Box<Account<'info, Observation>>,

    #[account(mut, address = observation.market @ PerpError::WrongOracleFeed)]
    pub market: Box<Account<'info, Market>>,

    #[account(
        seeds = [MARK_KEEPER_SEED, market.pool.as_ref()],
        bump = mark_keeper.bump,
        constraint = mark_keeper.keeper == keeper.key()
            && keeper.key() != Pubkey::default() @ PerpError::NotMarkKeeper,
    )]
    pub mark_keeper: Box<Account<'info, MarkKeeper>>,

    /// CHECK: validated by the reader for `observation.source_kind`, exactly
    /// as in `Observe`. Read for depth, which stays on-chain: the keeper names
    /// the price, never how much leverage or budget a pool supports.
    pub source: AccountInfo<'info>,
}

/// Sets an observed market's mark to the price the pool's mark keeper read.
///
/// This is how a market with no Pyth feed trades from its first minute rather
/// than after fifteen of them: a keeper reads the pool off-chain and pushes
/// the price. The first push makes the market
/// tradeable (see `Observation::set_by_keeper`). Depth is still read from the
/// pool here, in the same transaction, so leverage tiers and the depth cap on
/// a market's budget do not depend on the keeper. So is spot, which the
/// pushed price is held within `KEEPER_MAX_SPOT_GAP_BPS` of: the keeper picks
/// the mark, the pool decides the range it may be picked from.
pub fn push_mark(ctx: Context<PushMark>, price: u64) -> Result<()> {
    let o = &mut ctx.accounts.observation;
    let (spot, depth) = match SourceKind::from_u8(o.source_kind)? {
        SourceKind::RaydiumClmm => (
            clmm_spot_price(&ctx.accounts.source, &o.source, o.quote_is_token_0, o.unit_exp)?,
            clmm_depth_usd(&ctx.accounts.source, &o.source, o.quote_is_token_0)?,
        ),
        SourceKind::MeteoraDlmm => dlmm_read(
            &ctx.accounts.source,
            &o.source,
            ctx.remaining_accounts,
            o.dec_x,
            o.dec_y,
            o.quote_is_token_0,
            o.unit_exp,
        )?,
        SourceKind::OrcaWhirlpool => return err!(PerpError::InvalidOracleAccount),
    };
    let now = Clock::get()?.unix_timestamp;
    o.depth_usd = depth;
    o.track_depth(depth, now);
    ctx.accounts.market.depth_leverage_x = leverage_for_depth(o.sustained_depth_usd);
    o.set_by_keeper(price, spot, now)?;

    emit!(MarkPushed { market: o.market, price, spot, observations: o.observations });
    Ok(())
}

/// A mark set by the keeper. `spot` is the pool's own price in the same
/// transaction, so any gap between the two is on the record.
#[event]
pub struct MarkPushed {
    pub market: Pubkey,
    pub price: u64,
    pub spot: u64,
    pub observations: u32,
}

#[derive(Accounts)]
pub struct DeriveBudget<'info> {
    /// Mutable for its AUM drift: a smaller budget is less owed to winners.
    #[account(mut, seeds = [POOL_SEED, pool.usdc_mint.as_ref()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,

    #[account(mut, has_one = pool @ PerpError::MarketPoolMismatch)]
    pub market: Box<Account<'info, Market>>,

    #[account(
        seeds = [OBSERVATION_SEED, market.key().as_ref()],
        bump = observation.bump,
        constraint = observation.market == market.key() @ PerpError::WrongOracleFeed,
    )]
    pub observation: Box<Account<'info, Observation>>,
}

/// Cuts a market's loss budget to what its liquidity currently supports.
///
/// The rule it enforces: **a market may never cost the LPs more than it costs
/// to move its own price.** Depth is the price of a one percent move, read off
/// the pool itself, so a market whose liquidity has drained loses its
/// allowance automatically rather than when somebody notices.
///
/// Permissionless in one direction only, and that asymmetry is the whole
/// design. Anyone may lower a budget — spotting that a market has become cheap
/// to manipulate is a service, and making it require permission means it
/// happens late or not at all. Nobody may raise one here, because depth is
/// measurable *and temporarily purchasable*: an attacker who could mint a
/// budget by parking liquidity in a pool for one slot would have found a way
/// to write their own allowance, which is precisely what listing had to be
/// stopped from doing. Raising stays with whoever owns the risk.
pub fn derive_market_budget(ctx: Context<DeriveBudget>) -> Result<()> {
    require!(
        PriceSource::from_u8(ctx.accounts.market.price_source)? == PriceSource::Observed,
        PerpError::InvalidParameter
    );
    // Depth that has held, not the last reading: see `budget_depth_usd`.
    let supported = ctx.accounts.observation.budget_depth_usd;
    let market = &mut ctx.accounts.market;
    let owed_before = crate::aum::lp_owed_now(market)?;
    let before = market.loss_budget_usd;
    market.loss_budget_usd =
        depth_capped_budget(ctx.accounts.observation.is_seasoned(), supported, before)?;
    crate::aum::book_lp_drift(&mut ctx.accounts.pool, market, owed_before)?;
    emit!(BudgetDerived {
        market: market.key(),
        depth_usd: supported,
        was_usd: before,
        now_usd: supported,
    });
    Ok(())
}

/// The budget `derive_market_budget` leaves a market with: the pool's depth,
/// when the mark is seasoned and the depth is below the budget it has now.
/// Refused otherwise, so the call can only ever cut, and only on a mark with
/// enough history behind its depth reading to be believed.
pub fn depth_capped_budget(seasoned: bool, depth_usd: u64, budget_usd: u64) -> Result<u64> {
    require!(seasoned, PerpError::OracleNotSeasoned);
    require!(depth_usd < budget_usd, PerpError::InvalidParameter);
    Ok(depth_usd)
}

#[event]
pub struct BudgetDerived {
    pub market: Pubkey,
    /// What a one percent move in this market's pool costs, right now.
    pub depth_usd: u64,
    pub was_usd: u64,
    pub now_usd: u64,
}

#[cfg(test)]
mod tests {
    #[test]
    fn circle_devnet_usdc_quotes_a_listing_on_devnet_builds_only() {
        let (token, settle) = (Pubkey::new_unique(), Pubkey::new_unique());
        let circle = pubkey!("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
        let accepted = check_quote_side(&token, &circle, false, &settle).is_ok();
        assert_eq!(accepted, cfg!(feature = "devnet"));
        // A mint the lister made is never a dollar, on any build.
        assert!(check_quote_side(&token, &Pubkey::new_unique(), false, &settle).is_err());
    }

    use super::*;

    #[test]
    fn an_observed_feed_id_is_the_hash_of_amm_and_the_pool_bytes() {
        // Pinned so the scripts that list markets stay in step with the program.
        let pool = Pubkey::new_from_array([7; 32]);
        let mut preimage = b"amm:".to_vec();
        preimage.extend_from_slice(&[7; 32]);
        let want = anchor_lang::solana_program::hash::hash(&preimage).to_bytes();
        assert_eq!(observed_feed_id(&pool), want);
        assert_ne!(observed_feed_id(&pool), observed_feed_id(&Pubkey::new_from_array([8; 32])));
    }

    const K: u64 = 1_000 * USD_SCALE as u64; // $1,000

    fn code(e: anchor_lang::error::Error) -> u32 {
        match e {
            anchor_lang::error::Error::AnchorError(a) => a.error_code_number,
            anchor_lang::error::Error::ProgramError(_) => u32::MAX,
        }
    }

    #[test]
    fn observation_params_past_the_caps_are_refused() {
        // What the site lists with: a 5% fold and a 1% clamp.
        assert!(check_observation_params(500, 100, 0).is_ok());
        assert!(check_observation_params(MAX_ALPHA_BPS, MAX_MOVE_BPS, MAX_UNIT_EXP).is_ok());
        // A lister who could pick a 655% clamp, or a fold that takes the
        // reading almost whole, would have a mark one crank can walk.
        assert!(check_observation_params(500, MAX_MOVE_BPS + 1, 0).is_err());
        assert!(check_observation_params(500, u16::MAX, 0).is_err());
        assert!(check_observation_params(MAX_ALPHA_BPS + 1, 100, 0).is_err());
        assert!(check_observation_params(9_999, 100, 0).is_err());
        assert!(check_observation_params(0, 100, 0).is_err());
        assert!(check_observation_params(500, 0, 0).is_err());
    }

    #[test]
    fn one_thin_reading_cuts_a_budget_by_a_tenth_of_the_gap_at_most() {
        // A $100k pool read honestly, then thinned for one crank (a swap into
        // a thin range, or a DLMM bin array left out) to $1k.
        let mut o = depth_state();
        o.track_depth(100 * K, 1_000);
        o.track_depth(K, 1_001);
        assert_eq!(o.budget_depth_usd, 100 * K, "inside the interval: no cut at all");
        o.track_depth(K, 1_000 + DEPTH_RISE_MIN_INTERVAL_SEC);
        assert_eq!(o.budget_depth_usd, 90_100 * K / 1_000);
        // A burst of thin readings in that interval counts once.
        for _ in 0..30 {
            o.track_depth(K, 1_000 + DEPTH_RISE_MIN_INTERVAL_SEC);
        }
        assert_eq!(o.budget_depth_usd, 90_100 * K / 1_000);
        // Honest readings take it back up, a step an interval.
        o.track_depth(100 * K, 1_000 + 2 * DEPTH_RISE_MIN_INTERVAL_SEC);
        assert_eq!(o.budget_depth_usd, 90_100 * K / 1_000 + 9_900 * K / 10_000);
        let mut t = 1_000 + 2 * DEPTH_RISE_MIN_INTERVAL_SEC;
        for _ in 0..60 {
            t += DEPTH_RISE_MIN_INTERVAL_SEC;
            o.track_depth(100 * K, t);
        }
        assert!(o.budget_depth_usd > 99 * K);
        // A pool that has really drained gets there: under 10% in 22 steps,
        // about seven minutes.
        t += 1_000;
        for _ in 0..22 {
            t += DEPTH_RISE_MIN_INTERVAL_SEC;
            o.track_depth(0, t);
        }
        assert!(o.budget_depth_usd < 10 * K, "{}", o.budget_depth_usd);
    }

    /// SP-4. Depth parked in the pool for one crank (a flash loan is
    /// enough) must not lift the depth a budget may be cut to back over the
    /// budget. Rising to any higher reading at once let one such crank undo
    /// minutes of decline, so a budget could be held above what the pool
    /// supports for the price of one transaction every few minutes.
    #[test]
    fn one_deep_reading_lifts_budget_depth_by_a_tenth_at_most() {
        let mut o = depth_state();
        o.track_depth(100 * K, 1_000);
        // The pool drains to $20k and the budget depth follows it down.
        let mut t = 1_000;
        for _ in 0..30 {
            t += DEPTH_RISE_MIN_INTERVAL_SEC;
            o.track_depth(20 * K, t);
        }
        let low = o.budget_depth_usd;
        assert!(low < 24 * K, "{low}");
        // Then $10m for one crank.
        t += DEPTH_RISE_MIN_INTERVAL_SEC;
        o.track_depth(10_000 * K, t);
        assert!(o.budget_depth_usd <= low + low / 10, "{} from {low}", o.budget_depth_usd);
        // Inside the same interval a burst moves it no further.
        for _ in 0..30 {
            o.track_depth(10_000 * K, t);
        }
        assert!(o.budget_depth_usd <= low + low / 10);
    }

    #[test]
    fn a_tracked_pool_must_be_quoted_in_a_dollar_on_the_side_named() {
        let usdc = QUOTE_MINTS[0];
        let settle = Pubkey::new_unique();
        let token = Pubkey::new_unique();
        assert!(check_quote_side(&token, &usdc, false, &settle).is_ok());
        assert!(check_quote_side(&usdc, &token, true, &settle).is_ok());
        // The pool's own settlement mint counts, for test clusters.
        assert!(check_quote_side(&token, &settle, false, &settle).is_ok());
        // The flag pointed at the asset would mark the market upside down.
        assert!(check_quote_side(&token, &usdc, true, &settle).is_err());
        // A pool quoted in a token the lister minted prices nothing.
        assert!(check_quote_side(&token, &Pubkey::new_unique(), false, &settle).is_err());
    }

    #[test]
    fn the_mint_offsets_read_a_live_raydium_pool() {
        // The mainnet SOL/USDC concentrated pool: wrapped SOL is token 0 and
        // USDC token 1.
        let data = include_bytes!("../fixtures/3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv.bin");
        let mint = |at: usize| Pubkey::new_from_array(data[at..at + 32].try_into().unwrap());
        assert_eq!(mint(CLMM_MINT_0), pubkey!("So11111111111111111111111111111111111111112"));
        assert_eq!(mint(CLMM_MINT_1), QUOTE_MINTS[0]);
        assert!(check_quote_side(&mint(CLMM_MINT_0), &mint(CLMM_MINT_1), false, &Pubkey::default()).is_ok());
    }

    #[test]
    fn a_derived_budget_cuts_to_depth_and_never_raises() {
        assert_eq!(depth_capped_budget(true, 40 * K, 100 * K).unwrap(), 40 * K);
        // Depth at or above the budget is not a cut, and is refused.
        assert!(depth_capped_budget(true, 100 * K, 100 * K).is_err());
        assert!(depth_capped_budget(true, 500 * K, 100 * K).is_err());
        // A pool that drained cuts the budget to nothing.
        assert_eq!(depth_capped_budget(true, 0, 100 * K).unwrap(), 0);
        // An unfunded market has nothing to cut.
        assert!(depth_capped_budget(true, 0, 0).is_err());
    }

    #[test]
    fn an_unseasoned_mark_cannot_cut_a_budget() {
        let e = depth_capped_budget(false, 0, 100 * K).unwrap_err();
        assert_eq!(code(e), u32::from(PerpError::OracleNotSeasoned));
    }

    fn depth_state() -> Observation {
        Observation {
            bump: 0,
            market: Pubkey::default(),
            source: Pubkey::default(),
            source_kind: SourceKind::RaydiumClmm as u8,
            quote_is_token_0: false,
            ewma_price: 0,
            last_spot: 0,
            last_update_ts: 0,
            first_update_ts: 0,
            observations: 0,
            alpha_bps: 500,
            max_move_bps: 100,
            depth_usd: 0,
            dec_x: 0,
            dec_y: 0,
            unit_exp: 0,
            sustained_depth_usd: 0,
            depth_rise_ts: 0,
            keeper_priced: false,
            budget_depth_usd: 0,
            _reserved: [0; 3],
        }
    }

    /// The tier one `observe` writes onto the market, from a depth reading.
    fn crank(o: &mut Observation, depth: u64, now: i64) -> u8 {
        o.track_depth(depth, now);
        leverage_for_depth(o.sustained_depth_usd)
    }

    #[test]
    fn a_new_market_opens_at_the_lowest_tier_and_earns_the_next_over_minutes() {
        // A steady $60k pool cranked every 20 seconds. Sustained depth closes
        // a tenth of the gap each time: $6k, $11.4k, ... toward $60k.
        let mut o = depth_state();
        let tiers: Vec<u8> = (0..30).map(|i| crank(&mut o, 60 * K, 1_000 + 20 * i)).collect();
        assert_eq!(tiers[0], 2);
        let first = |x: u8| tiers.iter().position(|&t| t >= x).unwrap();
        assert_eq!(first(3), 1, "3x on the second reading");
        // 4x needs $50k sustained: 18 readings, six minutes of depth that stayed.
        assert_eq!(first(4), 17);
        assert!(tiers.iter().all(|&t| t <= 4), "a $60k pool never reaches 5x");
    }

    #[test]
    fn a_thinning_pool_drops_the_tier_on_the_same_crank() {
        let mut o = depth_state();
        o.sustained_depth_usd = 300 * K;
        o.depth_rise_ts = 1_000;
        assert_eq!(leverage_for_depth(o.sustained_depth_usd), 5);
        // Inside the rise interval, a fall still lands at once.
        assert_eq!(crank(&mut o, 5 * K, 1_001), 2);
        assert_eq!(o.sustained_depth_usd, 5 * K);
    }

    #[test]
    fn thirty_cranks_in_one_second_count_parked_depth_once() {
        let mut o = depth_state();
        for _ in 0..30 {
            crank(&mut o, 90 * K, 1_000);
        }
        assert_eq!(o.sustained_depth_usd, 9 * K);
        assert_eq!(leverage_for_depth(o.sustained_depth_usd), 2);
    }

    /// Before the rise was capped at the next tier, one crank on $2.5m parked
    /// in a fresh market's pool wrote 5x. Now it buys one tier, and the next
    /// honest reading takes that back. See
    /// `one_crank_raises_leverage_by_at_most_one_tier` in proofs/listing.rs.
    #[test]
    fn one_parked_reading_buys_at_most_one_tier() {
        let mut o = depth_state();
        assert_eq!(crank(&mut o, 2_500 * K, 1_000), 3);
        assert_eq!(crank(&mut o, 5 * K, 1_001), 2);
    }

    #[test]
    fn the_unclamped_fold_is_the_weighted_mean_rounded_down() {
        // A 5% fold from $100 toward $200 is $105.
        assert_eq!(folded_unclamped(100_000_000, 200_000_000, 500), 105_000_000);
        assert_eq!(folded_unclamped(100_000_000, 0, 500), 95_000_000);
        // All weight on the reading, or none.
        assert_eq!(folded_unclamped(7, 9, BPS as u16), 9);
        assert_eq!(folded_unclamped(7, 9, 0), 7);
        // No overflow at the top of the range.
        assert_eq!(folded_unclamped(u64::MAX, u64::MAX, 500), u64::MAX);
        assert_eq!(folded_unclamped(3, 4, 5_000), 3, "3.5 rounds down");
    }
}
