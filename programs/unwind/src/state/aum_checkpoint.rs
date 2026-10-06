use anchor_lang::prelude::*;

/// The pool's trader PnL, summed across every market with open interest by
/// a pass of `checkpoint_aum` calls, so deposits and withdrawals can price LP
/// shares without carrying every one of those markets.
///
/// They used to: `(market, price)` for each market with open interest, two
/// accounts apiece, in the same transaction as the deposit. Past about
/// twenty-four such markets that crossed Solana's 64-account lock limit and
/// nobody could deposit or withdraw at all, which permissionless listing
/// makes a matter of time rather than of chance. A pass adds markets in
/// strictly increasing address order over as many transactions as it needs;
/// it completes when it has counted `markets_with_oi` of them under one
/// `oi_version`, and a deposit accepts only a completed pass that is recent
/// and taken under the open-interest set the pool has now.
#[account]
#[derive(InitSpace)]
pub struct AumCheckpoint {
    pub pool: Pubkey,
    pub bump: u8,

    /// The pass being built.
    pub pass_open: bool,
    pub pass_started_ts: i64,
    pub pass_version: u16,
    pub pass_markets: u16,
    pub pass_counted: u16,
    pub pass_last_market: Pubkey,
    /// Trader PnL as a deposit reads it: each market at whichever of its
    /// oracle and risk price leaves the pool worth more (see
    /// `lp_pnl_against_the_mover`), less that market's `aum_drift_usd` at the
    /// reading. Wrapping; only meaningful once the pool's drift is added back
    /// (`checkpoint_pnl_usd`), which brings each market up to date with what
    /// was settled in it since.
    pub pass_pnl_usd: i64,
    /// The same pass as a withdrawal claim reads it: each market at whichever
    /// leaves the pool worth less.
    pub pass_claim_pnl_usd: i64,
    /// Markets the pass counted at their worst because their price could not
    /// be read (see `Unpriced`).
    pub pass_unpriced: u16,

    /// The last pass that completed. `done_ts` is when it started, so its age
    /// is the age of its oldest reading.
    pub done_ts: i64,
    pub done_version: u16,
    pub done_markets: u16,
    pub done_pnl_usd: i64,
    pub done_claim_pnl_usd: i64,
    pub done_unpriced: u16,

    pub _reserved: [u8; 12],
}
