use crate::errors::PerpError;
use crate::instructions::batch::market_price;
use crate::state::*;
use anchor_lang::prelude::*;

/// What the LPs' share of the pool is worth, in USD: their USDC, less what
/// traders are up, plus any tokens backing has paid them in kind.
///
/// `remaining_accounts` must be `(market, price_update)` pairs covering every
/// market that carries open interest -- `pool.markets_with_oi` of them, and no
/// others -- then `(custody, price_update)` pairs for every custody in index
/// order. The completeness check is the point: pricing LP shares against a
/// subset of those markets is exactly how a depositor front-runs a loss the
/// pool has already taken but not yet booked, and leaving a custody out would
/// sell shares without the tokens the LPs hold. Markets nobody holds a position
/// in are left out because they owe nothing, which is what lets anyone list
/// without growing this list.
pub fn pool_aum_usd<'info>(
    pool: &Account<'info, Pool>,
    remaining_accounts: &'info [AccountInfo<'info>],
) -> Result<u64> {
    let m = (pool.markets_with_oi as usize) * 2;
    require!(
        remaining_accounts.len() == m + (pool.num_custodies as usize) * 2,
        PerpError::IncompleteMarketList
    );
    let (markets, custodies) = remaining_accounts.split_at(m);
    let pnl = global_trader_pnl_usd(pool, markets)?;
    let in_kind = lp_in_kind_usd(pool, custodies)?;
    Ok(pool.aum_with_in_kind_usd(pnl, in_kind))
}

/// Tokens the LPs own in the pool's custodies, at the oracle.
fn lp_in_kind_usd<'info>(pool: &Account<'info, Pool>, pairs: &'info [AccountInfo<'info>]) -> Result<u64> {
    let mut total = 0u64;
    for (k, pair) in pairs.chunks(2).enumerate() {
        let c: Account<Custody> = Account::try_from(&pair[0])?;
        require_keys_eq!(c.pool, pool.key(), PerpError::MarketPoolMismatch);
        require!(c.index as usize == k, PerpError::IncompleteCustodyList);
        if c.lp_amount == 0 {
            continue;
        }
        let price = c.price(&pair[1], &pool.pyth_receiver)?;
        total = total
            .checked_add(token_value_usd(c.lp_amount, price, c.decimals)?)
            .ok_or(PerpError::MathOverflow)?;
    }
    Ok(total)
}

/// Sums unrealized trader PnL across every market in the pool, from
/// `(market, price_update)` pairs covering each market with open interest.
pub fn global_trader_pnl_usd<'info>(
    pool: &Account<'info, Pool>,
    remaining_accounts: &'info [AccountInfo<'info>],
) -> Result<i64> {
    require!(
        remaining_accounts.len() == (pool.markets_with_oi as usize) * 2,
        PerpError::IncompleteMarketList
    );

    let mut total: i64 = 0;
    let mut seen: Vec<Pubkey> = Vec::with_capacity(pool.markets_with_oi as usize);

    for pair in remaining_accounts.chunks(2) {
        let market_ai = &pair[0];
        let price_ai = &pair[1];

        let market: Account<Market> = Account::try_from(market_ai)?;
        require_keys_eq!(market.pool, pool.key(), PerpError::MarketPoolMismatch);
        require!(
            !seen.contains(&market_ai.key()),
            PerpError::IncompleteMarketList
        );
        seen.push(market_ai.key());

        // Only markets with open interest belong here. With the count fixed at
        // `markets_with_oi` and duplicates refused, admitting an empty market
        // would let a caller pass it in place of one with positions, and so
        // leave that one's PnL out of the price.
        require!(market.has_open_interest(), PerpError::IncompleteMarketList);
        // Whichever mark the market is priced from: a Pyth feed, or the
        // observation of a pool for a market somebody listed.
        let oracle = market_price(price_ai, pool, &market, market_ai.key)?;

        total = total
            .checked_add(market.trader_pnl_usd(oracle.price)?)
            .ok_or(PerpError::MathOverflow)?;
    }

    Ok(total)
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
            _reserved: [0; 3],
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
            _reserved: [0; 32],
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

    #[test]
    fn with_nothing_open_and_nothing_held_aum_is_the_liquidity() {
        let (_, p) = pool_account(&pool(7_000_000, 0, 0));
        assert_eq!(pool_aum_usd(&p, accounts(vec![])).unwrap(), 7_000_000);
    }

    #[test]
    fn a_market_list_short_of_the_markets_with_open_interest_is_refused() {
        // One market carries positions. Pricing the pool without it would let
        // a depositor buy in at a price that ignores what that market owes.
        let (_, p) = pool_account(&pool(7_000_000, 1, 0));
        let e = pool_aum_usd(&p, accounts(vec![])).unwrap_err();
        assert_eq!(code(e), u32::from(PerpError::IncompleteMarketList));
        let e = global_trader_pnl_usd(&p, accounts(vec![])).unwrap_err();
        assert_eq!(code(e), u32::from(PerpError::IncompleteMarketList));
    }

    #[test]
    fn extra_accounts_are_refused_too() {
        // No market is open, so a (market, price) pair has no business here.
        let (_, p) = pool_account(&pool(7_000_000, 0, 0));
        let e = pool_aum_usd(&p, accounts(vec![unread(), unread()])).unwrap_err();
        assert_eq!(code(e), u32::from(PerpError::IncompleteMarketList));
    }

    #[test]
    fn a_custody_list_short_of_the_pool_is_refused() {
        // Leaving a custody out would sell shares without the tokens the LPs
        // hold in it.
        let (_, p) = pool_account(&pool(7_000_000, 0, 1));
        let e = pool_aum_usd(&p, accounts(vec![])).unwrap_err();
        assert_eq!(code(e), u32::from(PerpError::IncompleteMarketList));
    }

    #[test]
    fn tokens_the_lps_hold_in_kind_are_added_at_the_price() {
        let (key, p) = pool_account(&pool(7_000_000, 0, 1));
        // 2.5 tokens of a stable at a dollar ($1 is 1,000,000). The backers'
        // 123 tokens are not the LPs' and must not count.
        let c = owned(Pubkey::new_unique(), &custody(key, 0, 2_500_000, true));
        let aum = pool_aum_usd(&p, accounts(vec![c, unread()])).unwrap();
        assert_eq!(aum, 7_000_000 + 2_500_000);
    }

    #[test]
    fn a_custody_the_lps_hold_nothing_in_is_not_priced() {
        // Not a stable, so pricing it would read the feed. The feed passed
        // here is an empty account, and the call still succeeds.
        let (key, p) = pool_account(&pool(7_000_000, 0, 1));
        let c = owned(Pubkey::new_unique(), &custody(key, 0, 0, false));
        assert_eq!(pool_aum_usd(&p, accounts(vec![c, unread()])).unwrap(), 7_000_000);
    }

    #[test]
    fn custodies_out_of_order_or_from_another_pool_are_refused() {
        let (key, p) = pool_account(&pool(7_000_000, 0, 1));
        let wrong_slot = owned(Pubkey::new_unique(), &custody(key, 1, 1, true));
        let e = pool_aum_usd(&p, accounts(vec![wrong_slot, unread()])).unwrap_err();
        assert_eq!(code(e), u32::from(PerpError::IncompleteCustodyList));

        let elsewhere = owned(Pubkey::new_unique(), &custody(Pubkey::new_unique(), 0, 1, true));
        let e = pool_aum_usd(&p, accounts(vec![elsewhere, unread()])).unwrap_err();
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
