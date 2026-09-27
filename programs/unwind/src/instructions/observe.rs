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
    #[account(mut)]
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
/// Permissionless, and deliberately harmless: creating this account begins a
/// clock and nothing else. The mark it builds cannot be traded against until
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
    require!(params.alpha_bps > 0 && (params.alpha_bps as u128) < BPS, PerpError::InvalidParameter);
    require!(params.max_move_bps > 0, PerpError::InvalidParameter);
    require!(params.unit_exp <= MAX_UNIT_EXP, PerpError::InvalidParameter);

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
            check_clmm_pool(source.owner, &source.try_borrow_data()?)?;
            (0, 0)
        }
        SourceKind::MeteoraDlmm => {
            // The pair has no decimals of its own, so the lister passes both
            // mints and they are read once, here. Checking each against the
            // pair's own record of its mints is what stops a lister passing a
            // mint with convenient decimals and shifting the mark by powers
            // of ten.
            let pair = parse_dlmm_pair(source.owner, &source.try_borrow_data()?)?;
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
    o.fold(spot, now)?;

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
/// a market's budget do not depend on the keeper.
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
    #[account(seeds = [POOL_SEED, pool.usdc_mint.as_ref()], bump = pool.bump)]
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
    let supported = ctx.accounts.observation.depth_usd;
    let market = &mut ctx.accounts.market;
    let before = market.loss_budget_usd;
    market.loss_budget_usd =
        depth_capped_budget(ctx.accounts.observation.is_seasoned(), supported, before)?;
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
            _reserved: [0; 11],
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
}
