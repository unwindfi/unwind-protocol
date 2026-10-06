use crate::constants::*;
use crate::errors::PerpError;
use crate::instructions::batch::market_price;
use crate::state::*;
use anchor_lang::prelude::*;

/// What the LPs' share of the pool is worth, in USD: their USDC, less what
/// traders are up, plus any tokens backing has paid them in kind.
///
/// What traders are up comes from the pool's AUM checkpoint (see
/// `AumCheckpoint`), which must be a completed pass under the open-interest
/// set the pool has now and no older than `AUM_MAX_AGE_SEC`.
/// `remaining_accounts` are `(custody, price_update)` pairs for every custody
/// in index order. Leaving a custody out would sell shares without the tokens
/// the LPs hold, which is why that list must be complete.
pub fn pool_aum_usd<'info>(
    pool: &Account<'info, Pool>,
    checkpoint: &AumCheckpoint,
    now: i64,
    remaining_accounts: &'info [AccountInfo<'info>],
    unpriced: Unpriced,
) -> Result<u64> {
    require!(
        remaining_accounts.len() == (pool.num_custodies as usize) * 2,
        PerpError::IncompleteCustodyList
    );
    let pnl = checkpoint_pnl_usd(pool.key(), pool.oi_version, pool.markets_with_oi, checkpoint, now, unpriced)?;
    // A checkpoint that counted a market at its worst because its price could
    // not be read refuses a deposit, which can wait for the price, and prices
    // a withdrawal, which must not be locked in by one stalled feed.
    if unpriced == Unpriced::Refuse {
        require!(checkpoint.done_unpriced == 0, PerpError::StaleOracle);
    }
    let in_kind = lp_in_kind_usd(pool, remaining_accounts)?;
    Ok(pool.aum_with_in_kind_usd(pnl, in_kind))
}

/// What to do with a market whose price could not be read.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Unpriced {
    /// Refuse, as a deposit does: it can wait for the price.
    Refuse,
    /// Count it at the most it could cost the LPs, as a withdrawal does.
    AtWorst,
}

/// Whether a failed price read means the price is unusable right now (old,
/// too uncertain, not seasoned) rather than that the wrong account was
/// passed. Only the first may be counted at worst in a checkpoint: a pass is
/// shared, and letting anyone mark a market unpriced by passing another
/// account would let them refuse every deposit and cheapen every withdrawal.
fn price_unusable(e: &Error) -> bool {
    match e {
        Error::AnchorError(a) => [
            PerpError::StaleOracle,
            PerpError::OracleConfidenceTooWide,
            PerpError::OracleNotSeasoned,
        ]
        .iter()
        .any(|c| a.error_code_number == u32::from(*c)),
        Error::ProgramError(_) => false,
    }
}

/// Trader PnL from a checkpoint, if the pool may be priced from it now: the
/// deposit-side sum for a deposit (`Refuse`), the claim-side sum for a
/// withdrawal (`AtWorst`). See `lp_pnl_against_the_mover`.
pub fn checkpoint_pnl_usd(
    pool: Pubkey,
    oi_version: u16,
    markets_with_oi: u16,
    c: &AumCheckpoint,
    now: i64,
    side: Unpriced,
) -> Result<i64> {
    require_keys_eq!(c.pool, pool, PerpError::MarketPoolMismatch);
    require!(
        c.done_ts > 0
            && c.done_version == oi_version
            && c.done_markets == markets_with_oi
            && now.saturating_sub(c.done_ts) <= AUM_MAX_AGE_SEC,
        PerpError::AumCheckpointStale
    );
    Ok(match side {
        Unpriced::Refuse => c.done_pnl_usd,
        Unpriced::AtWorst => c.done_claim_pnl_usd,
    })
}

/// One step of a checkpoint pass: optionally start a new pass, then add the
/// `(market, price_update)` pairs, which must come in strictly increasing
/// market address order and each carry open interest. Completes the pass
/// when it has counted every market with open interest.
///
/// A new pass may start only when none is open, the open one has run past
/// `AUM_PASS_MAX_SEC`, or the open-interest set has changed under it; so a
/// pass somebody started and left can be finished by anyone, and cannot be
/// restarted over and over to keep deposits waiting.
pub fn fold_checkpoint<'info>(
    pool: &Account<'info, Pool>,
    c: &mut AumCheckpoint,
    restart: bool,
    now: i64,
    pairs: &'info [AccountInfo<'info>],
) -> Result<()> {
    require!(pairs.len() % 2 == 0, PerpError::IncompleteMarketList);
    let moved = c.pass_version != pool.oi_version || c.pass_markets != pool.markets_with_oi;
    let stale = now.saturating_sub(c.pass_started_ts) > AUM_PASS_MAX_SEC;
    if restart {
        require!(!c.pass_open || stale || moved, PerpError::InvalidParameter);
        c.pass_open = true;
        c.pass_started_ts = now;
        c.pass_version = pool.oi_version;
        c.pass_markets = pool.markets_with_oi;
        c.pass_counted = 0;
        c.pass_last_market = Pubkey::default();
        c.pass_pnl_usd = 0;
        c.pass_claim_pnl_usd = 0;
        c.pass_unpriced = 0;
    } else {
        require!(c.pass_open && !stale && !moved, PerpError::AumCheckpointStale);
    }

    for pair in pairs.chunks(2) {
        let market: Account<Market> = Account::try_from(&pair[0])?;
        require_keys_eq!(market.pool, pool.key(), PerpError::MarketPoolMismatch);
        // Increasing order is what makes double counting impossible across
        // the pass's transactions, and the count is what makes it complete.
        require!(pair[0].key() > c.pass_last_market, PerpError::IncompleteMarketList);
        require!(market.has_open_interest(), PerpError::IncompleteMarketList);
        require!(c.pass_counted < c.pass_markets, PerpError::IncompleteMarketList);
        // Both sides from the same reading: a deposit at whichever of the
        // oracle and the risk price makes the pool worth more, a claim at
        // whichever makes it worth less.
        let (deposit_pnl, claim_pnl) = match market_price(&pair[1], pool, &market, pair[0].key) {
            Ok(oracle) => (
                lp_pnl_against_the_mover(&market, oracle.price, Unpriced::Refuse)?,
                lp_pnl_against_the_mover(&market, oracle.price, Unpriced::AtWorst)?,
            ),
            Err(e) if price_unusable(&e) => {
                c.pass_unpriced += 1;
                let worst = market.lp_worst_pnl_usd();
                (worst, worst)
            }
            Err(e) => return Err(e),
        };
        c.pass_pnl_usd = c.pass_pnl_usd.checked_add(deposit_pnl).ok_or(PerpError::MathOverflow)?;
        c.pass_claim_pnl_usd = c
            .pass_claim_pnl_usd
            .checked_add(claim_pnl)
            .ok_or(PerpError::MathOverflow)?;
        c.pass_counted += 1;
        c.pass_last_market = pair[0].key();
    }

    if c.pass_counted == c.pass_markets {
        c.done_ts = c.pass_started_ts;
        c.done_version = c.pass_version;
        c.done_markets = c.pass_markets;
        c.done_pnl_usd = c.pass_pnl_usd;
        c.done_claim_pnl_usd = c.pass_claim_pnl_usd;
        c.done_unpriced = c.pass_unpriced;
        c.pass_open = false;
    }
    Ok(())
}

/// Tokens the LPs own in the pool's custodies, at the oracle.
fn lp_in_kind_usd<'info>(pool: &Account<'info, Pool>, pairs: &'info [AccountInfo<'info>]) -> Result<u64> {
    lp_in_kind(pool, pairs)?.iter().try_fold(0u64, |a, (_, v)| {
        a.checked_add(*v).ok_or(PerpError::MathOverflow.into())
    })
}

/// Every custody from `(custody, price_update)` pairs, which must be all of
/// them in index order, with what the LPs' tokens in it are worth at the
/// oracle. A custody the LPs hold nothing in is not priced.
pub fn lp_in_kind<'info>(
    pool: &Account<'info, Pool>,
    pairs: &'info [AccountInfo<'info>],
) -> Result<Vec<(Account<'info, Custody>, u64)>> {
    require!(
        pairs.len() == (pool.num_custodies as usize) * 2,
        PerpError::IncompleteCustodyList
    );
    let mut out = Vec::with_capacity(pairs.len() / 2);
    for (k, pair) in pairs.chunks(2).enumerate() {
        let c: Account<'info, Custody> = Account::try_from(&pair[0])?;
        require_keys_eq!(c.pool, pool.key(), PerpError::MarketPoolMismatch);
        require!(c.index as usize == k, PerpError::IncompleteCustodyList);
        let value = if c.lp_amount == 0 {
            0
        } else {
            let price = c.price(&pair[1], &pool.pyth_receiver)?;
            token_value_usd(c.lp_amount, price, c.decimals)?
        };
        out.push((c, value));
    }
    Ok(out)
}

/// What a market's traders are up, as the pool owes it (see
/// `Market::lp_pnl_usd`: positive is the pool down), at whichever of the oracle and the market's
/// risk price is worse for whoever is moving money now.
///
/// The risk price trails the oracle by up to one step per slot, so after a
/// move the two disagree for a while. Valuing the pool at the oracle alone
/// lets a depositor buy in just before the risk price catches up with a loss,
/// or a leaver claim just before it catches up with a gain. So a deposit
/// (`Refuse`) counts the pool at the higher of the two values, and buys fewer
/// shares; a claim (`AtWorst`) counts it at the lower, and is paid less. A
/// market with no risk price on record yet is valued at the oracle.
pub fn lp_pnl_against_the_mover(market: &Market, target: u64, unpriced: Unpriced) -> Result<i64> {
    let at_target = market.lp_pnl_usd(target)?;
    if market.risk_price == 0 || market.risk_price == target {
        return Ok(at_target);
    }
    let at_risk = market.lp_pnl_usd(market.risk_price)?;
    Ok(match unpriced {
        // Less owed is more pool value.
        Unpriced::Refuse => at_target.min(at_risk),
        Unpriced::AtWorst => at_target.max(at_risk),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn leak<T>(t: T) -> &'static mut T {
        Box::leak(Box::new(t))
    }

    /// An account owned by this program holding `acct`, as the runtime would
    /// hand it over. Leaked so it lives as long as `pool_aum_usd` needs.
    fn owned<T: AccountSerialize>(key: Pubkey, acct: &T) -> AccountInfo<'static> {
        let mut data = Vec::new();
        acct.try_serialize(&mut data).unwrap();
        AccountInfo::new(
            leak(key),
            false,
            false,
            leak(1_000_000_000u64),
            Box::leak(data.into_boxed_slice()),
            leak(crate::ID),
            false,
            0,
        )
    }

    /// An empty account, standing in for a price feed the code must not read.
    fn unread() -> AccountInfo<'static> {
        AccountInfo::new(
            leak(Pubkey::new_unique()),
            false,
            false,
            leak(0u64),
            Box::leak(Vec::new().into_boxed_slice()),
            leak(Pubkey::default()),
            false,
            0,
        )
    }

    fn pool(liquidity_usd: u64, markets_with_oi: u16, num_custodies: u8) -> Pool {
        Pool {
            bump: 0,
            vault_bump: 0,
            lp_mint_bump: 0,
            authority: Pubkey::default(),
            pending_authority: Pubkey::default(),
            usdc_mint: Pubkey::default(),
            usdc_vault: Pubkey::default(),
            lp_mint: Pubkey::default(),
            num_markets: 0,
            liquidity_usd,
            locked_usd: 0,
            trader_collateral_usd: 0,
            protocol_fees_usd: 0,
            add_liquidity_fee_bps: 0,
            remove_liquidity_fee_bps: 0,
            protocol_fee_share_bps: 0,
            max_utilization_bps: 0,
            insurance_usd: 0,
            insurance_fee_share_bps: 0,
            pyth_receiver: Pubkey::default(),
            escrow_usd: 0,
            chain_fee_destination: Pubkey::default(),
            chain_fees_usd: 0,
            rewards_usd: 0,
            paused: false,
            backing_usd: 0,
            num_custodies,
            markets_with_oi,
            oi_version: 0,
            _reserved: [0; 1],
        }
    }

    /// A custody of a 6-decimal token with `lp_amount` owned by the LPs and
    /// 123 tokens held for backers. A stable one is priced at a dollar
    /// without reading a feed.
    fn custody(pool: Pubkey, index: u8, lp_amount: u64, is_stable: bool) -> Custody {
        Custody {
            bump: 0,
            vault_bump: 0,
            pool,
            mint: Pubkey::default(),
            vault: Pubkey::default(),
            decimals: 6,
            index,
            is_stable,
            feed_id: [0; 32],
            max_price_age_sec: 0,
            max_conf_bps: 0,
            budget_weight_bps: 10_000,
            backing_amount: 123_000_000,
            lp_amount,
            lp_owed_amount: 0,
            _reserved: [0; 24],
        }
    }

    fn pool_account(p: &Pool) -> (Pubkey, Account<'static, Pool>) {
        let key = Pubkey::new_unique();
        let info: &'static AccountInfo<'static> = leak(owned(key, p));
        (key, Account::try_from(info).unwrap())
    }

    fn code(e: Error) -> u32 {
        match e {
            Error::AnchorError(a) => a.error_code_number,
            Error::ProgramError(p) => panic!("expected an anchor error, got {p:?}"),
        }
    }

    fn accounts(v: Vec<AccountInfo<'static>>) -> &'static [AccountInfo<'static>] {
        Box::leak(v.into_boxed_slice())
    }

    const NOW: i64 = 1_000_000;

    /// A completed checkpoint for `pool`, taken `age` seconds ago.
    fn done(pool: Pubkey, version: u16, markets: u16, pnl: i64, age: i64) -> AumCheckpoint {
        AumCheckpoint {
            pool, bump: 0,
            pass_open: false, pass_started_ts: NOW - age, pass_version: version,
            pass_markets: markets, pass_counted: markets, pass_last_market: Pubkey::default(),
            pass_pnl_usd: pnl,
            pass_claim_pnl_usd: pnl,
            pass_unpriced: 0,
            done_ts: NOW - age, done_version: version, done_markets: markets, done_pnl_usd: pnl,
            done_claim_pnl_usd: pnl,
            done_unpriced: 0,
            _reserved: [0; 12],
        }
    }

    #[test]
    fn a_lagging_risk_price_is_read_against_whoever_moves_money() {
        let mut m = crate::instructions::trade::tests::market();
        // $10,000 long from $100. The oracle is at $110, the risk price still
        // at $105: the longs are up less at $105, so the pool is worth more.
        m.long_size_usd = 10_000_000_000;
        m.long_avg_entry_price = 100_000_000;
        m.risk_price = 105_000_000;
        let at_target = m.lp_pnl_usd(110_000_000).unwrap();
        let at_risk = m.lp_pnl_usd(105_000_000).unwrap();
        assert!(at_risk < at_target, "the pool owes less at $105");
        // A deposit buys at the higher pool value, a claim is paid at the lower.
        assert_eq!(lp_pnl_against_the_mover(&m, 110_000_000, Unpriced::Refuse).unwrap(), at_risk);
        assert_eq!(lp_pnl_against_the_mover(&m, 110_000_000, Unpriced::AtWorst).unwrap(), at_target);
        // And the other way round when the risk price trails a fall.
        m.risk_price = 115_000_000;
        let at_risk = m.lp_pnl_usd(115_000_000).unwrap();
        assert_eq!(lp_pnl_against_the_mover(&m, 110_000_000, Unpriced::Refuse).unwrap(), at_target);
        assert_eq!(lp_pnl_against_the_mover(&m, 110_000_000, Unpriced::AtWorst).unwrap(), at_risk);
        // No risk price on record: the oracle alone.
        m.risk_price = 0;
        assert_eq!(lp_pnl_against_the_mover(&m, 110_000_000, Unpriced::AtWorst).unwrap(), at_target);
    }

    #[test]
    fn with_nothing_open_and_nothing_held_aum_is_the_liquidity() {
        let (key, p) = pool_account(&pool(7_000_000, 0, 0));
        let c = done(key, 0, 0, 0, 5);
        assert_eq!(pool_aum_usd(&p, &c, NOW, accounts(vec![]), Unpriced::Refuse).unwrap(), 7_000_000);
    }

    #[test]
    fn what_traders_are_up_comes_off_the_checkpoint() {
        let (key, p) = pool_account(&pool(7_000_000, 3, 0));
        let c = done(key, 0, 3, 1_500_000, 5);
        assert_eq!(pool_aum_usd(&p, &c, NOW, accounts(vec![]), Unpriced::Refuse).unwrap(), 5_500_000);
    }

    #[test]
    fn a_deposit_reads_the_deposit_side_and_a_claim_the_claim_side() {
        // The pass summed traders up $1.0 at the reading that makes the pool
        // worth more and $1.5 at the one that makes it worth less.
        let (key, p) = pool_account(&pool(7_000_000, 1, 0));
        let mut c = done(key, 0, 1, 1_000_000, 5);
        c.done_claim_pnl_usd = 1_500_000;
        assert_eq!(pool_aum_usd(&p, &c, NOW, accounts(vec![]), Unpriced::Refuse).unwrap(), 6_000_000);
        assert_eq!(pool_aum_usd(&p, &c, NOW, accounts(vec![]), Unpriced::AtWorst).unwrap(), 5_500_000);
    }

    #[test]
    fn a_checkpoint_too_old_is_refused() {
        let (key, p) = pool_account(&pool(7_000_000, 1, 0));
        let c = done(key, 0, 1, 0, AUM_MAX_AGE_SEC + 1);
        let e = pool_aum_usd(&p, &c, NOW, accounts(vec![]), Unpriced::Refuse).unwrap_err();
        assert_eq!(code(e), u32::from(PerpError::AumCheckpointStale));
        let fresh = done(key, 0, 1, 0, AUM_MAX_AGE_SEC);
        assert!(pool_aum_usd(&p, &fresh, NOW, accounts(vec![]), Unpriced::Refuse).is_ok());
    }

    #[test]
    fn a_checkpoint_from_another_set_of_markets_is_refused() {
        // Same count, different set: the version tells them apart. Pricing a
        // deposit against markets that no longer carry the pool's positions
        // is how a depositor buys in ahead of a loss already taken.
        let mut q = pool(7_000_000, 2, 0);
        q.oi_version = 9;
        let (key, p) = pool_account(&q);
        let e = pool_aum_usd(&p, &done(key, 8, 2, 0, 5), NOW, accounts(vec![]), Unpriced::Refuse).unwrap_err();
        assert_eq!(code(e), u32::from(PerpError::AumCheckpointStale));
        let e = pool_aum_usd(&p, &done(key, 9, 1, 0, 5), NOW, accounts(vec![]), Unpriced::Refuse).unwrap_err();
        assert_eq!(code(e), u32::from(PerpError::AumCheckpointStale));
        assert!(pool_aum_usd(&p, &done(key, 9, 2, 0, 5), NOW, accounts(vec![]), Unpriced::Refuse).is_ok());
    }

    #[test]
    fn a_checkpoint_never_completed_or_of_another_pool_is_refused() {
        let (key, p) = pool_account(&pool(7_000_000, 0, 0));
        let mut never = done(key, 0, 0, 0, 5);
        never.done_ts = 0;
        let e = pool_aum_usd(&p, &never, NOW, accounts(vec![]), Unpriced::Refuse).unwrap_err();
        assert_eq!(code(e), u32::from(PerpError::AumCheckpointStale));
        let e = pool_aum_usd(&p, &done(Pubkey::new_unique(), 0, 0, 0, 5), NOW, accounts(vec![]), Unpriced::Refuse).unwrap_err();
        assert_eq!(code(e), u32::from(PerpError::MarketPoolMismatch));
    }

    #[test]
    fn a_checkpoint_with_an_unpriced_market_refuses_deposits_but_prices_withdrawals() {
        let (key, p) = pool_account(&pool(7_000_000, 1, 0));
        let mut c = done(key, 0, 1, 2_000_000, 5);
        c.done_unpriced = 1;
        let e = pool_aum_usd(&p, &c, NOW, accounts(vec![]), Unpriced::Refuse).unwrap_err();
        assert_eq!(code(e), u32::from(PerpError::StaleOracle));
        assert_eq!(pool_aum_usd(&p, &c, NOW, accounts(vec![]), Unpriced::AtWorst).unwrap(), 5_000_000);
    }

    #[test]
    fn a_pass_over_no_markets_completes_at_once() {
        let (key, p) = pool_account(&pool(7_000_000, 0, 0));
        let mut c = done(key, 0, 0, 0, 500);
        fold_checkpoint(&p, &mut c, true, NOW, accounts(vec![])).unwrap();
        assert!(!c.pass_open);
        assert_eq!((c.done_ts, c.done_markets), (NOW, 0));
    }

    #[test]
    fn an_open_pass_cannot_be_restarted_until_it_stalls_or_the_set_moves() {
        let (key, p) = pool_account(&pool(7_000_000, 2, 0));
        let mut c = done(key, 0, 2, 0, 500);
        fold_checkpoint(&p, &mut c, true, NOW, accounts(vec![])).unwrap();
        assert!(c.pass_open);
        // A second start while the first is fresh would let anyone keep
        // deposits waiting by restarting forever.
        assert!(fold_checkpoint(&p, &mut c, true, NOW + 1, accounts(vec![])).is_err());
        // Past the pass limit it may start again...
        fold_checkpoint(&p, &mut c, true, NOW + AUM_PASS_MAX_SEC + 1, accounts(vec![])).unwrap();
        // ...and continuing needs an open, fresh pass under the same set.
        assert!(fold_checkpoint(&p, &mut c, false, NOW + AUM_PASS_MAX_SEC + 2, accounts(vec![])).is_ok());
        let mut moved = (*p).clone();
        moved.oi_version = 1;
        let (_, p2) = pool_account(&moved);
        let mut c2 = c.clone();
        c2.pool = p2.key();
        assert!(fold_checkpoint(&p2, &mut c2, false, NOW + AUM_PASS_MAX_SEC + 2, accounts(vec![])).is_err());
        assert!(fold_checkpoint(&p2, &mut c2, true, NOW + AUM_PASS_MAX_SEC + 2, accounts(vec![])).is_ok());
    }

    #[test]
    fn a_custody_list_short_of_the_pool_is_refused() {
        // Leaving a custody out would sell shares without the tokens the LPs
        // hold in it.
        let (key, p) = pool_account(&pool(7_000_000, 0, 1));
        let e = pool_aum_usd(&p, &done(key, 0, 0, 0, 5), NOW, accounts(vec![]), Unpriced::Refuse).unwrap_err();
        assert_eq!(code(e), u32::from(PerpError::IncompleteCustodyList));
    }

    #[test]
    fn tokens_the_lps_hold_in_kind_are_added_at_the_price() {
        let (key, p) = pool_account(&pool(7_000_000, 0, 1));
        // 2.5 tokens of a stable at a dollar ($1 is 1,000,000). The backers'
        // 123 tokens are not the LPs' and must not count.
        let c = owned(Pubkey::new_unique(), &custody(key, 0, 2_500_000, true));
        let aum = pool_aum_usd(&p, &done(key, 0, 0, 0, 5), NOW, accounts(vec![c, unread()]), Unpriced::Refuse).unwrap();
        assert_eq!(aum, 7_000_000 + 2_500_000);
    }

    #[test]
    fn a_custody_the_lps_hold_nothing_in_is_not_priced() {
        // Not a stable, so pricing it would read the feed. The feed passed
        // here is an empty account, and the call still succeeds.
        let (key, p) = pool_account(&pool(7_000_000, 0, 1));
        let c = owned(Pubkey::new_unique(), &custody(key, 0, 0, false));
        assert_eq!(pool_aum_usd(&p, &done(key, 0, 0, 0, 5), NOW, accounts(vec![c, unread()]), Unpriced::Refuse).unwrap(), 7_000_000);
    }

    #[test]
    fn custodies_out_of_order_or_from_another_pool_are_refused() {
        let (key, p) = pool_account(&pool(7_000_000, 0, 1));
        let wrong_slot = owned(Pubkey::new_unique(), &custody(key, 1, 1, true));
        let e = pool_aum_usd(&p, &done(key, 0, 0, 0, 5), NOW, accounts(vec![wrong_slot, unread()]), Unpriced::Refuse).unwrap_err();
        assert_eq!(code(e), u32::from(PerpError::IncompleteCustodyList));

        let elsewhere = owned(Pubkey::new_unique(), &custody(Pubkey::new_unique(), 0, 1, true));
        let e = pool_aum_usd(&p, &done(key, 0, 0, 0, 5), NOW, accounts(vec![elsewhere, unread()]), Unpriced::Refuse).unwrap_err();
        assert_eq!(code(e), u32::from(PerpError::MarketPoolMismatch));
    }

    #[test]
    fn in_kind_is_added_after_trader_profit_is_floored() {
        // Pins the order `pool_aum_usd` adds things in: traders up 10 against
        // 0 liquidity floors to 0, and 10 of in-kind value then counts in
        // full rather than covering the profit. See
        // `a_deposit_into_an_underwater_pool_is_not_diluted` in
        // src/proofs/liquidity.rs for what that does to a deposit.
        let (key, p) = pool_account(&pool(0, 0, 1));
        let c = owned(Pubkey::new_unique(), &custody(key, 0, 10, true));
        assert_eq!(lp_in_kind_usd(&p, accounts(vec![c, unread()])).unwrap(), 10);
        assert_eq!(p.aum_usd(10), 0);
    }
}
