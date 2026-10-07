//! Actions, the runner that turns them into transactions, and the invariants
//! checked after every one of them.
//!
//! An action names its actors and markets by small integers taken modulo
//! what exists, so every generated value means something and a shrunk case
//! still reads as a story: trader 1 opens a long, the price drops 30%, the
//! risk price catches up, somebody liquidates.
//!
//! A transaction the program refuses with one of its own errors is recorded
//! and the run goes on: refusing is the program's right. What fails a case is
//! a broken invariant, or a transaction that aborts (a panic, an overflow
//! trap, running out of compute) instead of refusing.

use super::env::*;
use anchor_lang::prelude::Pubkey;
use proptest::prelude::*;
use solana_signer::Signer;
use std::collections::BTreeMap;
use std::fmt;
use unwind::constants::BPS;
use unwind::math::{funding_owed_usd, position_pnl_usd};
use unwind::state::{Batch, Market, Pool, Position};

const BPS_I: i128 = BPS as i128;

// ------------------------------------------------------------------ actions

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    /// An opening order. `limit_bps` is how far through the mark the limit
    /// sits: positive crosses (a bid above the mark), negative rests behind.
    /// `crank` clears and settles the market straight after.
    Open { trader: u8, market: u8, long: bool, maker: bool, size_usd: u32, lev_x: u8, limit_bps: i16, crank: bool },
    /// A reduce-only order for `pct` percent of what is still closable, by
    /// the `nth` holder of an open position in the market.
    Close { nth: u8, market: u8, pct: u8, maker: bool, limit_bps: i16, crank: bool },
    /// Cancels the trader's `nth` active order in the market's open batch.
    Cancel { trader: u8, market: u8, nth: u8 },
    /// Waits out the batch interval and clears.
    Clear { market: u8 },
    /// Settles the `nth` active order of a sealed batch.
    SettleOne { market: u8, nth: u8 },
    /// Settles every active order of a sealed batch, starting from `start`.
    SettleAll { market: u8, start: u8 },
    /// Clear then settle everything: one tick of the crank.
    Crank { market: u8 },
    /// Moves a market's oracle by `bps`, one second later.
    MovePrice { market: u8, bps: i16 },
    /// A resting maker order and an opposing taker from another trader, same
    /// size, then a crank: two traders crossing each other with the pool
    /// out of it, which the random mix alone rarely lines up.
    Cross { maker: u8, taker: u8, market: u8, maker_long: bool, size_usd: u32, lev_x: u8, crank: bool },
    /// Gaps the oracle `bps` against the `nth` open position in the market
    /// and lets the risk price catch up: the setup for a liquidation, or for
    /// a bankrupt one when the gap is past the collateral. `liquidate` then
    /// tries to liquidate it.
    /// `favor` moves it the position's way instead, making a winner.
    Shock { nth: u8, market: u8, bps: u16, liquidate: bool, favor: bool },
    /// Moves the clock. `repost` has the relay post fresh prices after it;
    /// without, prices may go stale and reads are refused.
    Warp { secs: u16, repost: bool },
    /// Steps the risk price toward the oracle `times` times, three slots apart.
    StepRisk { market: u8, times: u8 },
    AccrueFunding { market: u8 },
    /// Liquidates the `nth` open position in the market. `catch_up` first
    /// steps the risk price until it reaches the oracle, as a keeper would
    /// before trying.
    Liquidate { nth: u8, market: u8, catch_up: bool },
    /// Accrues, checkpoints and deposits `usd` dollars.
    LpDeposit { lp: u8, usd: u32 },
    /// Escrows `pct` percent of the LP's shares for withdrawal.
    LpRequest { lp: u8, pct: u8 },
    /// Claims `pct` percent of the escrowed shares, first waiting out the
    /// cooldown when `wait` is set.
    LpClaim { lp: u8, pct: u8, wait: bool },
    LpCancel { lp: u8 },
    Back { backer: u8, market: u8, usd: u32 },
    /// Withdraws `pct` percent of the backer's shares.
    Unback { backer: u8, market: u8, pct: u8 },
}

impl Action {
    /// Actions that only trade: no oracle move, no LP or backer money in or
    /// out. The clock may tick (a clear waits out its interval), which only
    /// moves funding, and funding is valued on both sides of the check.
    pub fn is_trader_only(&self) -> bool {
        matches!(
            self,
            Action::Open { .. }
                | Action::Close { .. }
                | Action::Cancel { .. }
                | Action::Clear { .. }
                | Action::SettleOne { .. }
                | Action::SettleAll { .. }
                | Action::Crank { .. }
                | Action::Liquidate { .. }
        )
    }
}

fn size_strategy() -> impl Strategy<Value = u32> {
    prop_oneof![3 => 10u32..200, 4 => 200u32..5_000, 2 => 5_000u32..40_000]
}

/// Leverage in x. Mostly inside every market's cap (5x on the tightest),
/// sometimes at or past the 10x and 20x ones.
fn lev_strategy() -> impl Strategy<Value = u8> {
    prop_oneof![4 => 1u8..=5, 4 => 5u8..=10, 2 => 10u8..=22]
}

fn move_strategy() -> impl Strategy<Value = i16> {
    prop_oneof![
        5 => -150i16..=150,
        3 => -800i16..=800,
        // Gaps: the kind of move that leaves positions past their margin
        // before anyone can act.
        3 => -4_000i16..=4_000,
        2 => prop::sample::select(vec![-9_000i16, -7_500, -5_000, 5_000, 10_000, 20_000]),
    ]
}

fn warp_strategy() -> impl Strategy<Value = u16> {
    prop_oneof![5 => 1u16..10, 3 => 10u16..120, 2 => 600u16..30_000]
}

pub fn action_strategy() -> impl Strategy<Value = Action> {
    let small = || 0u8..8;
    prop_oneof![
        14 => (
            (small(), small(), any::<bool>(), prop::bool::weighted(0.3)),
            (size_strategy(), lev_strategy(), -50i16..=300, prop::bool::weighted(0.5)),
        )
            .prop_map(|((trader, market, long, maker), (size_usd, lev_x, limit_bps, crank))| Action::Open {
                trader, market, long, maker, size_usd, lev_x, limit_bps, crank
            }),
        6 => (small(), small(), 1u8..=100, prop::bool::weighted(0.2), -20i16..=400, prop::bool::weighted(0.5))
            .prop_map(|(nth, market, pct, maker, limit_bps, crank)| Action::Close { nth, market, pct, maker, limit_bps, crank }),
        1 => (small(), small(), small()).prop_map(|(trader, market, nth)| Action::Cancel { trader, market, nth }),
        3 => small().prop_map(|market| Action::Clear { market }),
        2 => (small(), any::<u8>()).prop_map(|(market, nth)| Action::SettleOne { market, nth }),
        3 => (small(), any::<u8>()).prop_map(|(market, start)| Action::SettleAll { market, start }),
        8 => small().prop_map(|market| Action::Crank { market }),
        8 => (small(), move_strategy()).prop_map(|(market, bps)| Action::MovePrice { market, bps }),
        4 => (small(), small(), 300u16..=9_000, prop::bool::weighted(0.7), prop::bool::weighted(0.35))
            .prop_map(|(nth, market, bps, liquidate, favor)| Action::Shock { nth, market, bps, liquidate, favor }),
        5 => ((small(), small(), small(), any::<bool>()), (size_strategy(), lev_strategy(), prop::bool::weighted(0.8)))
            .prop_map(|((maker, taker, market, maker_long), (size_usd, lev_x, crank))| Action::Cross {
                maker, taker, market, maker_long, size_usd, lev_x, crank
            }),
        3 => (warp_strategy(), prop::bool::weighted(0.85)).prop_map(|(secs, repost)| Action::Warp { secs, repost }),
        3 => (small(), 1u8..=30).prop_map(|(market, times)| Action::StepRisk { market, times }),
        2 => small().prop_map(|market| Action::AccrueFunding { market }),
        5 => (small(), small(), prop::bool::weighted(0.6))
            .prop_map(|(nth, market, catch_up)| Action::Liquidate { nth, market, catch_up }),
        2 => (small(), 1u32..300_000).prop_map(|(lp, usd)| Action::LpDeposit { lp, usd }),
        2 => (small(), 1u8..=100).prop_map(|(lp, pct)| Action::LpRequest { lp, pct }),
        2 => (small(), 1u8..=100, prop::bool::weighted(0.8)).prop_map(|(lp, pct, wait)| Action::LpClaim { lp, pct, wait }),
        1 => small().prop_map(|lp| Action::LpCancel { lp }),
        2 => (small(), small(), 1u32..200_000).prop_map(|(backer, market, usd)| Action::Back { backer, market, usd }),
        2 => (small(), small(), 1u8..=100).prop_map(|(backer, market, pct)| Action::Unback { backer, market, pct }),
    ]
}

// ------------------------------------------------------------------ snapshot

/// Everything the invariants read, taken at one instant.
#[derive(Clone)]
pub struct Snap {
    pub pool: Pool,
    pub markets: Vec<Market>,
    pub batches: Vec<Batch>,
    /// `positions[m][t]`, `None` where the account does not exist.
    pub positions: Vec<Vec<Option<Position>>>,
    pub vault: u64,
    pub usdc_supply: u64,
    pub lp_supply: u64,
    /// Every USDC balance the harness knows outside the vault.
    pub wallets_usdc: u64,
    pub trader_usdc: Vec<u64>,
    pub authority_usdc: u64,
    pub lp_balances: u64,
    pub lp_escrows: u64,
    pub now: i64,
    pub oracle: Vec<u64>,
}

impl Snap {
    pub fn take(env: &Env) -> Snap {
        let n = env.markets.len();
        let markets: Vec<Market> = (0..n).map(|m| env.market_state(m)).collect();
        let batches = (0..n).map(|m| env.batch_state(m)).collect();
        let positions = (0..n)
            .map(|m| env.traders.iter().map(|k| env.position_state(m, &k.pubkey())).collect())
            .collect();
        let owners: Vec<Pubkey> = std::iter::once(env.authority.pubkey())
            .chain(env.traders.iter().map(|k| k.pubkey()))
            .chain(env.lps.iter().map(|k| k.pubkey()))
            .chain(env.backers.iter().map(|k| k.pubkey()))
            .collect();
        Snap {
            pool: env.pool_state(),
            markets,
            batches,
            positions,
            vault: env.token_balance(&env.vault),
            usdc_supply: env.mint_supply(&env.usdc_mint),
            lp_supply: env.mint_supply(&env.lp_mint),
            wallets_usdc: owners.iter().map(|o| env.usdc_of(o)).sum(),
            trader_usdc: env.traders.iter().map(|k| env.usdc_of(&k.pubkey())).collect(),
            authority_usdc: env.usdc_of(&env.authority.pubkey()),
            lp_balances: env.lps.iter().map(|k| env.lp_of(&k.pubkey())).sum(),
            lp_escrows: env.lps.iter().map(|k| env.token_balance(&env.withdraw_escrow(&k.pubkey()))).sum(),
            now: env.clock().unix_timestamp,
            oracle: env.markets.iter().map(|fx| fx.price).collect(),
        }
    }

    fn open_positions(&self, m: usize) -> impl Iterator<Item = &Position> {
        self.positions[m].iter().flatten().filter(|p| p.is_open())
    }
}

// ------------------------------------------------------------------ invariants

/// One broken invariant: its name and the numbers that broke it.
#[derive(Debug, Clone)]
pub struct Violation {
    pub invariant: &'static str,
    pub detail: String,
}

macro_rules! ensure {
    ($out:expr, $cond:expr, $name:expr, $($fmt:tt)*) => {
        if !$cond {
            $out.push(Violation { invariant: $name, detail: format!($($fmt)*) });
        }
    };
}

/// The value one position holds at `price` as `settle` would compute it,
/// before fees: `(pnl, funding owed, equity)`.
fn position_terms(market: &Market, p: &Position, price: u64) -> (i64, i64, i128) {
    let entry = market.adjust_entry_price(p.entry_price, p.entry_price_factor).unwrap_or(p.entry_price);
    let pnl = position_pnl_usd(p.is_long, p.size_usd, entry, price).unwrap_or(0);
    let funding = funding_owed_usd(p.size_usd, p.entry_funding, market.cumulative_funding(p.is_long)).unwrap_or(0);
    (pnl, funding, p.collateral_usd as i128 + pnl as i128 - funding as i128)
}

/// Invariants of a single state, checked after every successful transaction.
pub fn check_state(s: &Snap) -> Vec<Violation> {
    let mut v = vec![];
    let p = &s.pool;

    // Solvency, exact. Every USDC unit in the vault belongs to exactly one of
    // the pool's lines (the program's own reconciliation, `vault_books` in
    // instructions/trade.rs tests, plus `rewards_usd` carved out of the
    // protocol's line for referrers and deployers).
    let books: u128 = [
        p.liquidity_usd,
        p.backing_usd,
        p.protocol_fees_usd,
        p.chain_fees_usd,
        p.insurance_usd,
        p.trader_collateral_usd,
        p.escrow_usd,
        p.rewards_usd,
    ]
    .iter()
    .map(|&x| x as u128)
    .sum();
    ensure!(
        v,
        s.vault as u128 == books,
        "vault_reconciles",
        "vault {} != books {} (diff {}) liq {} backing {} prot {} chain {} ins {} coll {} escrow {} rewards {}",
        s.vault,
        books,
        s.vault as i128 - books as i128,
        p.liquidity_usd,
        p.backing_usd,
        p.protocol_fees_usd,
        p.chain_fees_usd,
        p.insurance_usd,
        p.trader_collateral_usd,
        p.escrow_usd,
        p.rewards_usd
    );

    // No USDC is created or destroyed: the mint's supply is all held by the
    // vault and the wallets the harness funded.
    ensure!(
        v,
        s.usdc_supply as u128 == s.vault as u128 + s.wallets_usdc as u128,
        "usdc_conserved",
        "supply {} != vault {} + wallets {}",
        s.usdc_supply,
        s.vault,
        s.wallets_usdc
    );
    // Every LP share is in a wallet or a withdrawal escrow.
    ensure!(
        v,
        s.lp_supply as u128 == s.lp_balances as u128 + s.lp_escrows as u128,
        "lp_shares_accounted",
        "lp supply {} != wallets {} + escrows {}",
        s.lp_supply,
        s.lp_balances,
        s.lp_escrows
    );

    // No balance has wrapped. Every USD line is bounded by all the money
    // there is; a u64 that wrapped below zero is far past it.
    let cap = s.usdc_supply;
    for (name, x) in [
        ("liquidity", p.liquidity_usd),
        ("locked", p.locked_usd),
        ("backing", p.backing_usd),
        ("protocol", p.protocol_fees_usd),
        ("chain", p.chain_fees_usd),
        ("insurance", p.insurance_usd),
        ("trader_collateral", p.trader_collateral_usd),
        ("escrow", p.escrow_usd),
        ("rewards", p.rewards_usd),
    ] {
        ensure!(v, x <= cap, "no_wrap", "pool.{name} = {x} exceeds every USDC there is ({cap})");
    }

    let mut sum_collateral: u128 = 0;
    let mut sum_backing: u128 = 0;
    let mut with_oi = 0u16;
    let mut drift: i64 = 0;
    for (m, mk) in s.markets.iter().enumerate() {
        for (name, x) in [
            ("collateral", mk.collateral_usd),
            ("backing", mk.backing_usd),
            ("backing_drawn", mk.backing_drawn_usd),
            ("deployer_rewards", mk.deployer_rewards_usd),
        ] {
            ensure!(v, x <= cap, "no_wrap", "market[{m}].{name} = {x} exceeds every USDC there is");
        }
        ensure!(
            v,
            mk.net_loss_usd.unsigned_abs() <= cap,
            "no_wrap",
            "market[{m}].net_loss_usd = {} is past every USDC there is",
            mk.net_loss_usd
        );

        // Open interest is the sum of the positions, per side.
        let long: u128 = s.open_positions(m).filter(|q| q.is_long).map(|q| q.size_usd as u128).sum();
        let short: u128 = s.open_positions(m).filter(|q| !q.is_long).map(|q| q.size_usd as u128).sum();
        ensure!(v, long == mk.long_size_usd as u128, "oi_matches_positions",
            "market[{m}] long_size_usd {} != sum of longs {long}", mk.long_size_usd);
        ensure!(v, short == mk.short_size_usd as u128, "oi_matches_positions",
            "market[{m}] short_size_usd {} != sum of shorts {short}", mk.short_size_usd);
        let coll: u128 = s.positions[m].iter().flatten().map(|q| q.collateral_usd as u128).sum();
        ensure!(v, coll == mk.collateral_usd as u128, "collateral_matches_positions",
            "market[{m}] collateral_usd {} != sum of positions {coll}", mk.collateral_usd);
        for (t, q) in s.positions[m].iter().enumerate() {
            if let Some(q) = q {
                ensure!(v, q.is_open() || q.collateral_usd == 0, "empty_position_holds_nothing",
                    "market[{m}] trader {t}: size 0 with collateral {}", q.collateral_usd);
            }
        }

        // The moment and funding sums track every position on both sides
        // (nothing here predates them, and no corporate action runs).
        for (side, size, mom, fun) in [
            ("long", mk.long_size_usd, mk.long_moments.tracked_usd, mk.long_funding.tracked_usd),
            ("short", mk.short_size_usd, mk.short_moments.tracked_usd, mk.short_funding.tracked_usd),
        ] {
            ensure!(v, mom == size, "moments_track_every_position",
                "market[{m}] {side}: moments track {mom} of {size}");
            ensure!(v, fun == size, "moments_track_every_position",
                "market[{m}] {side}: funding sums track {fun} of {size}");
        }

        // The budget: what this market has cost the LPs, net, never passes
        // what it was underwritten for. `charge_loss` refuses past it and
        // every payout path goes through it.
        ensure!(
            v,
            mk.net_loss_usd <= mk.loss_budget_usd as i64,
            "loss_within_budget",
            "market[{m}] net_loss_usd {} > loss_budget_usd {}",
            mk.net_loss_usd,
            mk.loss_budget_usd
        );

        // The bounds the payout haircut and LP claims are priced from must
        // never understate what the positions actually hold, at the price
        // the market last acted on and at the oracle now.
        let n_open = s.open_positions(m).count() as u128;
        for price in [unwind::aum::drift_price(mk), s.oracle[m]] {
            if price == 0 {
                continue;
            }
            for is_long in [true, false] {
                let actual_win: u128 = s
                    .open_positions(m)
                    .filter(|q| q.is_long == is_long)
                    .map(|q| position_terms(mk, q, price).0.max(0) as u128)
                    .sum();
                if let Ok(bound) = mk.side_winners_usd(is_long, price) {
                    ensure!(v, bound as u128 + n_open >= actual_win, "winners_bound_never_understates",
                        "market[{m}] {} at {price}: bound {bound} < winners {actual_win}",
                        if is_long { "long" } else { "short" });
                }
                let actual_bad: u128 = s
                    .open_positions(m)
                    .filter(|q| q.is_long == is_long)
                    .map(|q| (-position_terms(mk, q, price).2).max(0) as u128)
                    .sum();
                if let Some(bound) = mk.side_bad_debt_bound_usd(is_long, price) {
                    ensure!(v, bound as u128 + n_open >= actual_bad, "bad_debt_bound_never_understates",
                        "market[{m}] {} at {price}: bound {bound} < bad debt {actual_bad}",
                        if is_long { "long" } else { "short" });
                }
            }

            // The side aggregates price the book as the positions do, up to
            // the rounding of one average entry per side.
            if let Ok(agg) = mk.trader_pnl_usd(price) {
                let sum: i128 = s.open_positions(m).map(|q| position_terms(mk, q, price).0 as i128).sum();
                let slack: i128 = [(mk.long_size_usd, mk.long_avg_entry_price), (mk.short_size_usd, mk.short_avg_entry_price)]
                    .iter()
                    .filter(|(sz, _)| *sz > 0)
                    .map(|&(sz, avg)| 2 * (sz as i128) * (price as i128) / (avg.max(1) as i128) / (avg.max(1) as i128) + 2)
                    .sum::<i128>()
                    + n_open as i128;
                ensure!(v, (agg as i128 - sum).abs() <= slack, "aggregate_pnl_matches_positions",
                    "market[{m}] at {price}: aggregate {agg} vs positions {sum} (slack {slack})");
            }
        }
        if let Some(agg) = mk.funding_owed_usd() {
            let sum: i128 = s.open_positions(m).map(|q| position_terms(mk, q, 1).1 as i128).sum();
            ensure!(v, (agg as i128 - sum).abs() <= n_open as i128 + 1, "aggregate_funding_matches_positions",
                "market[{m}] funding owed aggregate {agg} vs positions {sum}");
        }

        // Close reservations: what each position has promised to resting
        // reduce-only orders is exactly what those orders ask for.
        let b = &s.batches[m];
        for (t, q) in s.positions[m].iter().enumerate() {
            let Some(q) = q else { continue };
            let reserved: u128 = b
                .orders
                .iter()
                .filter(|o| o.is_active() && o.reduces() && o.owner == q.owner)
                .map(|o| o.size_usd as u128)
                .sum();
            ensure!(v, reserved == q.closing_usd as u128, "close_reservations_match_orders",
                "market[{m}] trader {t}: closing_usd {} but resting reduce-only orders ask {reserved}", q.closing_usd);
        }

        sum_collateral += mk.collateral_usd as u128;
        sum_backing += mk.backing_usd as u128;
        if mk.has_open_interest() {
            with_oi += 1;
            drift = drift.wrapping_add(mk.aum_drift_usd);
        } else {
            ensure!(v, mk.aum_drift_usd == 0, "drift_cleared_without_oi",
                "market[{m}] has no open interest but drift {}", mk.aum_drift_usd);
        }
    }

    // The pool's per-market lines are the sums of the markets'.
    ensure!(v, sum_collateral == p.trader_collateral_usd as u128, "pool_collateral_is_market_sum",
        "pool.trader_collateral_usd {} != sum of markets {sum_collateral}", p.trader_collateral_usd);
    ensure!(v, sum_backing == p.backing_usd as u128, "pool_backing_is_market_sum",
        "pool.backing_usd {} != sum of markets {sum_backing}", p.backing_usd);
    let escrow: u128 = s
        .batches
        .iter()
        .flat_map(|b| b.orders.iter())
        .filter(|o| o.is_active() && !o.reduces())
        .map(|o| o.collateral_usd as u128)
        .sum();
    ensure!(v, escrow == p.escrow_usd as u128, "escrow_is_resting_collateral",
        "pool.escrow_usd {} != collateral on resting opens {escrow}", p.escrow_usd);
    ensure!(v, with_oi == p.markets_with_oi, "markets_with_oi_counted",
        "pool.markets_with_oi {} but {with_oi} markets carry open interest", p.markets_with_oi);
    ensure!(v, drift == p.aum_drift_usd, "pool_drift_is_market_sum",
        "pool.aum_drift_usd {} != sum over markets with open interest {drift}", p.aum_drift_usd);
    v
}

/// Which of the program's two LP valuations to read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Valuation {
    /// What a deposit is priced against (`Market::lp_pnl_usd`): every
    /// loser's loss collectable up to the market's whole collateral.
    Deposit,
    /// What a claim is priced against (`Market::lp_claim_pnl_usd`): an upper
    /// bound on bad debt added to what traders are owed, so nothing a
    /// bankrupt position cannot pay is counted as the pool's.
    Claim,
}

/// What the LPs own at the oracle, as the program values them: USDC
/// liquidity less what every market owes after its caps, with funding
/// brought up to now.
pub fn lp_value(s: &Snap, how: Valuation) -> i128 {
    let mut owed: i128 = 0;
    for (m, mk) in s.markets.iter().enumerate() {
        if !mk.has_open_interest() {
            continue;
        }
        let valued = unwind::aum::accrued_to(mk, &s.pool, s.now).expect("accrue");
        owed += match how {
            Valuation::Deposit => valued.lp_pnl_usd(s.oracle[m]),
            Valuation::Claim => valued.lp_claim_pnl_usd(s.oracle[m]),
        }
        .expect("lp pnl") as i128;
    }
    s.pool.liquidity_usd as i128 - owed
}

/// How a market's book, settled all at once at `price`, would split between
/// the LPs and the backers: `(lp_owed, backing_change)`, `lp_owed` positive
/// when the LPs pay.
///
/// The same split the program prices LP shares with (`Market::lp_from_net`
/// behind `lp_pnl_usd`: winners paid up to the remaining budget, backing
/// first; losers' collateral collected, backing restored first), but fed the
/// exact net the positions hold, each loser counted no further than its own
/// collateral, rather than the aggregate (which collects past a bankrupt
/// position's collateral) or the aggregate plus a bad-debt bound (which can
/// overstate it).
fn book_split(s: &Snap, m: usize) -> (i128, i128) {
    let mk = &s.markets[m];
    if !mk.has_open_interest() {
        return (0, 0);
    }
    let valued = unwind::aum::accrued_to(mk, &s.pool, s.now).expect("accrue");
    let price = s.oracle[m];
    let bad: i128 = s.open_positions(m).map(|q| (-position_terms(&valued, q, price).2).max(0)).sum();
    let net = (valued.trader_net_usd(price).expect("trader_net") as i128 + bad).clamp(i64::MIN as i128, i64::MAX as i128);
    if net >= 0 {
        let paid = (net as u64).min(valued.remaining_budget_usd());
        let from_backing = paid.min(valued.backing_usd);
        ((paid - from_backing) as i128, -(from_backing as i128))
    } else {
        let collected = (net.unsigned_abs() as u64).min(valued.collateral_usd);
        let restored = if valued.backing_shares == 0 { 0 } else { collected.min(valued.backing_drawn_usd) };
        (-((collected - restored) as i128), restored as i128)
    }
}

/// LP shares in issue, escrowed ones included: they keep their part of the
/// pool until burned.
fn lp_shares(s: &Snap) -> i128 {
    s.lp_supply as i128
}

// ------------------------------------------------------------------ runner

#[derive(Default, Clone)]
pub struct Stats {
    /// Per instruction: (succeeded, refused by error name).
    pub per_ix: BTreeMap<&'static str, (u64, BTreeMap<String, u64>)>,
    /// How often each interesting thing happened, from the program's own
    /// events and from the state after each action. A path that never shows
    /// up here is a path the run did not test.
    pub coverage: BTreeMap<&'static str, u64>,
    pub steps: u64,
}

/// Counts the events a landed transaction emitted that say which path it
/// took.
fn record_events(stats: &mut Stats, logs: &[String]) {
    use anchor_lang::{AnchorDeserialize, Discriminator};
    use base64::Engine;
    use unwind::instructions::{BatchCleared, InsuranceDrawn, PositionClosed, PositionLiquidated, ProfitHaircut};
    for l in logs {
        let Some(b64) = l.strip_prefix("Program data: ") else { continue };
        let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(b64.split(' ').next().unwrap_or("")) else {
            continue;
        };
        if bytes.len() < 8 {
            continue;
        }
        let (disc, mut body) = bytes.split_at(8);
        let c = &mut stats.coverage;
        if disc == ProfitHaircut::DISCRIMINATOR {
            *c.entry("event: profit haircut").or_default() += 1;
        } else if disc == InsuranceDrawn::DISCRIMINATOR {
            *c.entry("event: insurance drawn").or_default() += 1;
        } else if disc == PositionClosed::DISCRIMINATOR {
            if let Ok(e) = PositionClosed::deserialize(&mut body) {
                let k = if e.pnl_usd > 0 { "event: close in profit" } else { "event: close at a loss" };
                *c.entry(k).or_default() += 1;
            }
        } else if disc == PositionLiquidated::DISCRIMINATOR {
            if let Ok(e) = PositionLiquidated::deserialize(&mut body) {
                let k = if e.returned_usd == 0 { "event: liquidation, owner wiped out" } else { "event: liquidation, owner paid back" };
                *c.entry(k).or_default() += 1;
            }
        } else if disc == BatchCleared::DISCRIMINATOR {
            if let Ok(e) = BatchCleared::deserialize(&mut body) {
                if e.buy_matched_usd > 0 || e.sell_matched_usd > 0 {
                    *c.entry("event: batch crossed").or_default() += 1;
                }
                if e.pool_bought > 0 || e.pool_sold > 0 {
                    *c.entry("event: pool filled").or_default() += 1;
                }
                if (e.buy_matched_usd > e.pool_sold) || (e.sell_matched_usd > e.pool_bought) {
                    *c.entry("event: trader crossed trader").or_default() += 1;
                }
            }
        }
    }
}

/// Counts what the state after an action shows about how far it got.
fn record_state(stats: &mut Stats, s: &Snap) {
    let c = &mut stats.coverage;
    for (m, mk) in s.markets.iter().enumerate() {
        if mk.long_size_usd > 0 && mk.short_size_usd > 0 {
            *c.entry("state: both sides open").or_default() += 1;
        }
        if mk.net_loss_usd > 0 {
            *c.entry("state: market net down for LPs").or_default() += 1;
        }
        if mk.has_open_interest() && mk.remaining_budget_usd() == 0 {
            *c.entry("state: budget spent with positions open").or_default() += 1;
        }
        if mk.backing_drawn_usd > 0 {
            *c.entry("state: backing drawn on").or_default() += 1;
        }
        let valued = unwind::aum::accrued_to(mk, &s.pool, s.now).expect("accrue");
        if s.open_positions(m).any(|q| position_terms(&valued, q, s.oracle[m]).2 < 0) {
            *c.entry("state: a position past its collateral").or_default() += 1;
        }
    }
}

impl Stats {
    fn record(&mut self, ix: &'static str, outcome: &TxOutcome) {
        let e = self.per_ix.entry(ix).or_default();
        match outcome {
            TxOutcome::Ok => e.0 += 1,
            TxOutcome::Rejected { name, .. } => *e.1.entry(name.clone()).or_default() += 1,
            TxOutcome::Aborted { reason, .. } => *e.1.entry(format!("ABORT {reason}")).or_default() += 1,
        }
    }

    pub fn merge(&mut self, other: &Stats) {
        self.steps += other.steps;
        for (k, n) in &other.coverage {
            *self.coverage.entry(k).or_default() += n;
        }
        for (k, (ok, rej)) in &other.per_ix {
            let e = self.per_ix.entry(k).or_default();
            e.0 += ok;
            for (n, c) in rej {
                *e.1.entry(n.clone()).or_default() += c;
            }
        }
    }
}

impl fmt::Display for Stats {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        writeln!(f, "{} actions", self.steps)?;
        for (k, n) in &self.coverage {
            writeln!(f, "  {k:<44} {n:>7}")?;
        }
        for (k, (ok, rej)) in &self.per_ix {
            let refused: u64 = rej.values().sum();
            write!(f, "  {k:<22} ok {ok:>6}  refused {refused:>6}")?;
            let mut top: Vec<_> = rej.iter().collect();
            top.sort_by(|a, b| b.1.cmp(a.1));
            for (n, c) in top.iter().take(4) {
                write!(f, "  {n}:{c}")?;
            }
            writeln!(f)?;
        }
        Ok(())
    }
}

/// A failed case: where, why, and the trail of transactions that led there.
#[derive(Debug)]
pub struct Failure {
    pub step: usize,
    pub action: Action,
    pub what: String,
    pub trail: Vec<String>,
}

impl fmt::Display for Failure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        writeln!(f, "step {}: {:?}", self.step, self.action)?;
        writeln!(f, "{}", self.what)?;
        writeln!(f, "last transactions:")?;
        for t in self.trail.iter().rev().take(25).rev() {
            writeln!(f, "  {t}")?;
        }
        Ok(())
    }
}

pub struct Runner {
    pub env: Env,
    pub stats: Stats,
    trail: Vec<String>,
    step: usize,
    action: Option<Action>,
}

type Step = Result<(), Failure>;

impl Runner {
    pub fn new(env: Env) -> Runner {
        Runner { env, stats: Stats::default(), trail: vec![], step: 0, action: None }
    }

    fn fail(&self, what: String) -> Failure {
        Failure { step: self.step, action: self.action.expect("action"), what, trail: self.trail.clone() }
    }

    fn violations(&self, vs: Vec<Violation>) -> Step {
        if vs.is_empty() {
            return Ok(());
        }
        let text = vs.iter().map(|v| format!("INVARIANT {}: {}", v.invariant, v.detail)).collect::<Vec<_>>().join("\n");
        Err(self.fail(text))
    }

    /// Sends one transaction, records how it went, and checks the state
    /// invariants if it landed.
    fn tx(&mut self, label: &'static str, ix: (anchor_lang::solana_program::instruction::Instruction, solana_keypair::Keypair)) -> Result<TxOutcome, Failure> {
        let outcome = self.env.send(ix);
        self.stats.record(label, &outcome);
        let c = self.env.clock();
        self.trail.push(format!("[t={} s={}] {label}: {}", c.unix_timestamp, c.slot, match &outcome {
            TxOutcome::Ok => "ok".to_string(),
            TxOutcome::Rejected { name, .. } => format!("refused {name}"),
            TxOutcome::Aborted { reason, .. } => format!("ABORTED {reason}"),
        }));
        match &outcome {
            TxOutcome::Aborted { reason, logs } => {
                let tail = logs.iter().rev().take(12).rev().cloned().collect::<Vec<_>>().join("\n    ");
                return Err(self.fail(format!("ABORT in {label}: {reason}\n    {tail}")));
            }
            TxOutcome::Ok => {
                let logs = std::mem::take(&mut self.env.last_logs);
                record_events(&mut self.stats, &logs);
                self.violations(check_state(&Snap::take(&self.env)))?
            }
            TxOutcome::Rejected { .. } => {}
        }
        Ok(outcome)
    }

    pub fn run(&mut self, actions: &[Action]) -> Step {
        // The fixture itself must satisfy every invariant.
        self.action = actions.first().copied();
        self.violations(check_state(&Snap::take(&self.env)))?;
        for (i, a) in actions.iter().enumerate() {
            self.step = i;
            self.action = Some(*a);
            self.trail.push(format!("-- {i}: {a:?}"));
            let before = a.is_trader_only().then(|| Snap::take(&self.env));
            self.apply(*a)?;
            let after = Snap::take(&self.env);
            if let Some(before) = before {
                self.violations(check_trader_step(&before, &after))?;
            }
            record_state(&mut self.stats, &after);
            self.stats.steps += 1;
        }
        Ok(())
    }

    fn n_markets(&self) -> usize {
        self.env.markets.len()
    }

    /// One second and one slot on, with the relay's prices reposted: the
    /// cadence of a batch.
    fn tick(&mut self) {
        self.env.advance(1, 2);
        self.env.repost_all();
    }

    fn apply(&mut self, a: Action) -> Step {
        let nm = self.n_markets();
        match a {
            Action::Open { trader, market, long, maker, size_usd, lev_x, limit_bps, crank } => {
                let (t, m) = (trader as usize % N_TRADERS, market as usize % nm);
                let mk = self.env.market_state(m);
                let mark = self.env.markets[m].price;
                let size = size_usd as u64 * USD;
                let fee = size * mk.open_fee_bps as u64 / 10_000;
                let collateral = size / lev_x.max(1) as u64 + fee + 1;
                let price = limit_price(mark, long, limit_bps);
                self.tx("submit_open", self.env.ix_submit_order(t, m, price, size, collateral, long, false, maker))?;
                if crank {
                    self.crank(m)?;
                }
            }
            Action::Close { nth, market, pct, maker, limit_bps, crank } => {
                let m = market as usize % nm;
                let Some((t, pos)) = self.nth_open(m, nth) else { return Ok(()) };
                let closable = pos.closable_usd();
                let mk = self.env.market_state(m);
                let mut size = (closable as u128 * pct as u128 / 100) as u64;
                if size < mk.min_position_usd {
                    size = closable;
                }
                // Closing a long sells, closing a short buys.
                let is_bid = !pos.is_long;
                let price = limit_price(self.env.markets[m].price, is_bid, limit_bps);
                self.tx("submit_close", self.env.ix_submit_order(t, m, price, size, 0, is_bid, true, maker))?;
                if crank {
                    self.crank(m)?;
                }
            }
            Action::Cancel { trader, market, nth } => {
                let (t, m) = (trader as usize % N_TRADERS, market as usize % nm);
                let owner = self.env.traders[t].pubkey();
                let b = self.env.batch_state(m);
                let mine: Vec<u8> = (0..b.orders.len())
                    .filter(|&i| b.orders[i].is_active() && b.orders[i].owner == owner)
                    .map(|i| i as u8)
                    .collect();
                if mine.is_empty() {
                    return Ok(());
                }
                let idx = mine[nth as usize % mine.len()];
                self.tx("cancel_batch_order", self.env.ix_cancel_batch_order(t, m, idx))?;
            }
            Action::Clear { market } => {
                self.clear(market as usize % nm)?;
            }
            Action::SettleOne { market, nth } => {
                let m = market as usize % nm;
                let active = self.sealed_active(m);
                if active.is_empty() {
                    return Ok(());
                }
                let (i, owner) = active[nth as usize % active.len()];
                self.settle(m, i, owner)?;
            }
            Action::SettleAll { market, start } => {
                self.settle_all(market as usize % nm, start as usize)?;
            }
            Action::Crank { market } => {
                self.crank(market as usize % nm)?;
            }
            Action::MovePrice { market, bps } => {
                let m = market as usize % nm;
                self.tick();
                let old = self.env.markets[m].price as i128;
                let new = (old * (BPS_I + bps as i128) / BPS_I).max(1) as u64;
                self.env.post_price(m, new);
            }
            Action::Cross { maker, taker, market, maker_long, size_usd, lev_x, crank } => {
                let m = market as usize % nm;
                let (mt, tt) = (maker as usize % N_TRADERS, taker as usize % N_TRADERS);
                let tt = if tt == mt { (tt + 1) % N_TRADERS } else { tt };
                let mk = self.env.market_state(m);
                let mark = self.env.markets[m].price;
                let size = size_usd as u64 * USD;
                let collateral = size / lev_x.max(1) as u64 + size * mk.open_fee_bps as u64 / 10_000 + 1;
                // The maker quotes a little inside the mark, the taker reaches
                // past it, so the two cross at the maker's price or better.
                let mp = limit_price(mark, maker_long, -2);
                let tp = limit_price(mark, !maker_long, 60);
                self.tx("submit_open", self.env.ix_submit_order(mt, m, mp, size, collateral, maker_long, false, true))?;
                self.tx("submit_open", self.env.ix_submit_order(tt, m, tp, size, collateral, !maker_long, false, false))?;
                if crank {
                    self.crank(m)?;
                }
            }
            Action::Shock { nth, market, bps, liquidate, favor } => {
                let m = market as usize % nm;
                let Some((t, pos)) = self.nth_open(m, nth) else { return Ok(()) };
                self.tick();
                let old = self.env.markets[m].price as i128;
                let b = bps as i128;
                let down = pos.is_long != favor;
                let new = if down { old * (BPS_I - b) / BPS_I } else { old * (BPS_I + b) / BPS_I };
                self.env.post_price(m, new.max(1) as u64);
                self.catch_up(m)?;
                if liquidate {
                    let owner = self.env.traders[t].pubkey();
                    self.tx("liquidate", self.env.ix_liquidate(m, owner))?;
                }
            }
            Action::Warp { secs, repost } => {
                self.env.advance(secs as i64, secs as u64 * 5 / 2 + 1);
                if repost {
                    self.env.repost_all();
                }
            }
            Action::StepRisk { market, times } => {
                let m = market as usize % nm;
                for _ in 0..times {
                    self.env.advance(0, 3);
                    self.tx("step_risk_price", self.env.ix_step_risk_price(m))?;
                }
            }
            Action::AccrueFunding { market } => {
                let m = market as usize % nm;
                let before = Snap::take(&self.env);
                if let TxOutcome::Ok = self.tx("accrue_funding", self.env.ix_accrue_funding(m))? {
                    let after = Snap::take(&self.env);
                    self.violations(check_funding(&before, &after, m))?;
                }
            }
            Action::Liquidate { nth, market, catch_up } => {
                let m = market as usize % nm;
                let Some((t, _)) = self.nth_open(m, nth) else { return Ok(()) };
                if catch_up {
                    self.catch_up(m)?;
                }
                let owner = self.env.traders[t].pubkey();
                self.tx("liquidate", self.env.ix_liquidate(m, owner))?;
            }
            Action::LpDeposit { lp, usd } => {
                let l = lp as usize % N_LPS;
                self.prepare_lp()?;
                let before = Snap::take(&self.env);
                if let TxOutcome::Ok = self.tx("add_liquidity", self.env.ix_add_liquidity(l, usd as u64 * USD))? {
                    let after = Snap::take(&self.env);
                    self.violations(check_no_dilution("deposit", &before, &after))?;
                }
            }
            Action::LpRequest { lp, pct } => {
                let l = lp as usize % N_LPS;
                let held = self.env.lp_of(&self.env.lps[l].pubkey());
                let amount = (held as u128 * pct as u128 / 100) as u64;
                if amount == 0 {
                    return Ok(());
                }
                self.tx("request_withdraw", self.env.ix_request_withdraw(l, amount))?;
            }
            Action::LpClaim { lp, pct, wait } => {
                let l = lp as usize % N_LPS;
                let owner = self.env.lps[l].pubkey();
                let Some(req) = self.env.anchor::<unwind::state::WithdrawRequest>(&self.env.withdraw_request(&owner)) else {
                    return Ok(());
                };
                if wait {
                    self.env.advance(60, unwind::constants::WITHDRAW_COOLDOWN_SLOTS);
                    self.env.repost_all();
                }
                let amount = ((req.shares as u128 * pct as u128 / 100) as u64).max(1);
                self.prepare_lp()?;
                let before = Snap::take(&self.env);
                if let TxOutcome::Ok = self.tx("claim_withdraw", self.env.ix_claim_withdraw(l, amount))? {
                    let after = Snap::take(&self.env);
                    self.violations(check_no_dilution("claim", &before, &after))?;
                }
            }
            Action::LpCancel { lp } => {
                let l = lp as usize % N_LPS;
                let owner = self.env.lps[l].pubkey();
                if self.env.account(&self.env.withdraw_request(&owner)).is_none() {
                    return Ok(());
                }
                self.tx("cancel_withdraw", self.env.ix_cancel_withdraw(l))?;
            }
            Action::Back { backer, market, usd } => {
                let (b, m) = (backer as usize % N_BACKERS, market as usize % nm);
                self.tx("back_market", self.env.ix_back_market(b, m, usd as u64 * USD))?;
            }
            Action::Unback { backer, market, pct } => {
                let (b, m) = (backer as usize % N_BACKERS, market as usize % nm);
                let shares = self.env.backing_shares(b, m);
                let amount = (shares as u128 * pct as u128 / 100) as u64;
                if amount == 0 {
                    return Ok(());
                }
                if let TxOutcome::Ok = self.tx("unback_market", self.env.ix_unback_market(b, m, amount))? {
                    let after = Snap::take(&self.env);
                    self.violations(check_unback(&after, m))?;
                }
            }
        }
        Ok(())
    }

    /// Brings every market's funding up to now and takes a fresh AUM
    /// checkpoint, which a deposit or claim prices from.
    fn prepare_lp(&mut self) -> Step {
        for m in 0..self.n_markets() {
            self.tx("accrue_funding", self.env.ix_accrue_funding(m))?;
        }
        let pairs = self.env.oi_pairs();
        self.tx("checkpoint_aum", self.env.ix_checkpoint_aum(true, &pairs))?;
        Ok(())
    }

    /// The `nth` (wrapping) trader holding an open position in market `m`.
    fn nth_open(&self, m: usize, nth: u8) -> Option<(usize, Position)> {
        let open: Vec<(usize, Position)> = (0..N_TRADERS)
            .filter_map(|t| self.env.position_state(m, &self.env.traders[t].pubkey()).map(|p| (t, p)))
            .filter(|(_, p)| p.is_open())
            .collect();
        if open.is_empty() {
            return None;
        }
        Some(open[nth as usize % open.len()].clone())
    }

    /// Steps market `m`'s risk price until it reaches the oracle.
    fn catch_up(&mut self, m: usize) -> Step {
        for _ in 0..80 {
            if self.env.market_state(m).risk_price == self.env.markets[m].price {
                break;
            }
            self.env.advance(0, 3);
            if let TxOutcome::Rejected { .. } = self.tx("step_risk_price", self.env.ix_step_risk_price(m))? {
                break;
            }
        }
        Ok(())
    }

    fn crank(&mut self, m: usize) -> Step {
        self.clear(m)?;
        self.settle_all(m, 0)
    }

    fn clear(&mut self, m: usize) -> Step {
        if !self.env.batch_state(m).is_open() {
            return Ok(());
        }
        self.tick();
        self.tx("clear_batch", self.env.ix_clear_batch(m))?;
        Ok(())
    }

    /// Active orders of market `m`'s batch, when it is sealed.
    fn sealed_active(&self, m: usize) -> Vec<(u8, Pubkey)> {
        let b = self.env.batch_state(m);
        if b.is_open() {
            return vec![];
        }
        (0..b.orders.len()).filter(|&i| b.orders[i].is_active()).map(|i| (i as u8, b.orders[i].owner)).collect()
    }

    /// Settlement has no discretion and the batch is already sealed, so it
    /// must never be refused: a sealed batch that cannot settle stops the
    /// market, closes included.
    fn settle(&mut self, m: usize, index: u8, owner: Pubkey) -> Step {
        let outcome = self.tx("settle_order", self.env.ix_settle_order(m, index, owner))?;
        if let TxOutcome::Rejected { name, .. } = outcome {
            return Err(self.fail(format!(
                "INVARIANT settlement_never_refused: settle_order(market {m}, index {index}) refused with {name}"
            )));
        }
        Ok(())
    }

    fn settle_all(&mut self, m: usize, start: usize) -> Step {
        let mut active = self.sealed_active(m);
        if active.is_empty() {
            return Ok(());
        }
        let k = start % active.len();
        active.rotate_left(k);
        for (i, owner) in active {
            self.settle(m, i, owner)?;
        }
        Ok(())
    }
}

/// A limit `bps` through the mark for a buyer (`is_bid`) or a seller.
fn limit_price(mark: u64, is_bid: bool, bps: i16) -> u64 {
    let b = bps as i128;
    let p = if is_bid { mark as i128 * (BPS_I + b) / BPS_I } else { mark as i128 * (BPS_I - b) / BPS_I };
    p.max(1) as u64
}

/// Funding mints nothing: across one accrual, with sizes unchanged, what
/// the positions owe in total moves by `d_long * long + d_short * short`,
/// which is the borrow leg (paid to the pool, never negative) plus the skew
/// leg (the heavy side's payment less the light side's receipt, which the
/// program rounds in the pool's favor). Negative would mean the light side
/// was credited more than the heavy side paid.
pub fn check_funding(before: &Snap, after: &Snap, m: usize) -> Vec<Violation> {
    let mut v = vec![];
    let (b, a) = (&before.markets[m], &after.markets[m]);
    if b.long_size_usd != a.long_size_usd || b.short_size_usd != a.short_size_usd {
        return v;
    }
    let dl = a.cumulative_long_funding - b.cumulative_long_funding;
    let ds = a.cumulative_short_funding - b.cumulative_short_funding;
    let net = dl * a.long_size_usd as i128 + ds * a.short_size_usd as i128;
    ensure!(v, net >= 0, "funding_mints_nothing",
        "market[{m}] d_long {dl} x {} + d_short {ds} x {} = {net} < 0", a.long_size_usd, a.short_size_usd);
    // Each side alone: a side that is not the light one never receives.
    if a.long_size_usd > 0 && a.short_size_usd > 0 {
        let longs_heavy = a.long_size_usd >= a.short_size_usd;
        let heavy_delta = if longs_heavy { dl } else { ds };
        ensure!(v, heavy_delta >= 0, "funding_heavy_side_pays",
            "market[{m}] heavy side's index moved by {heavy_delta}");
    }
    v
}

/// Everything a trade can move value between, valued at the oracle with
/// funding brought up to now: `(lp, traders, others)`.
///
/// - `lp` is the LPs' USDC less what the open books owe them or take from
///   them (`book_split`).
/// - `traders` is what the traders hold: their wallets, their escrowed
///   order collateral, and each position's equity, never below zero since
///   a trader cannot owe more than they posted.
/// - `others` is every other claim on the vault a trade can pay into: the
///   protocol, chain, insurance and reward lines, the liquidator's wallet,
///   and backing, less what it would pay winners now or plus what losers
///   would restore to it (`book_split`).
pub fn value_split(s: &Snap) -> (i128, i128, i128) {
    let mut traders: i128 = s.trader_usdc.iter().map(|&x| x as i128).sum::<i128>() + s.pool.escrow_usd as i128;
    let mut lp_owed: i128 = 0;
    let mut backing = s.pool.backing_usd as i128;
    for (m, mk) in s.markets.iter().enumerate() {
        let valued = unwind::aum::accrued_to(mk, &s.pool, s.now).expect("accrue");
        for q in s.open_positions(m) {
            traders += position_terms(&valued, q, s.oracle[m]).2.max(0);
        }
        let (lp, b) = book_split(s, m);
        lp_owed += lp;
        backing += b;
    }
    let p = &s.pool;
    let others = [p.protocol_fees_usd, p.chain_fees_usd, p.insurance_usd, p.rewards_usd, s.authority_usdc]
        .iter()
        .map(|&x| x as i128)
        .sum::<i128>()
        + backing;
    (p.liquidity_usd as i128 - lp_owed, traders, others)
}

/// LP share price never jumps from trading alone without somebody paying
/// for it. Across an action that only trades, at an unchanged oracle, the
/// LPs' value may rise by no more than traders and the other lines lose:
/// `d_lp + d_traders + d_others <= slack`.
///
/// The LPs' value here is the program's own split of each book between LPs
/// and backers, fed the exact net the positions hold (`book_split`). That
/// split is exact for value that moves between the parties (fees, the
/// spread a fill pays against the mark, a loss realized at close), so those
/// net to zero. So a rise means value the book did not hold a moment
/// earlier: a depositor in that window bought shares cheap, or a trader was
/// paid out of nobody's loss.
///
/// The weakening: the check is skipped while any market's winners could
/// reach its remaining budget (see the body). There the payable value
/// depends on settlement order by design, and the first long run found
/// exactly that: a bankrupt loser liquidated ahead of a capped winner moved
/// value between the winner, the backers and the LPs with no loss at the
/// mark.
///
/// The program's two readings themselves bracket this one: the deposit
/// reading collects past a bankrupt loser's collateral and the claim
/// reading adds an upper bound on bad debt, and both bounds are checked in
/// `check_state`. Either reading can move against this one when a position
/// leaves the book, which is why neither is used here.
///
/// `slack` covers the rounding of the side aggregates and of per-position
/// funding, a few units per position.
pub fn check_trader_step(before: &Snap, after: &Snap) -> Vec<Violation> {
    let mut v = vec![];
    if before.oracle != after.oracle || before.lp_supply != after.lp_supply {
        return v;
    }
    // Only where every market last acted at the price it is valued at now. A
    // batch cleared before the oracle moved settles at the old price, and
    // the position it books carries that move with it: value the price made,
    // not the trade.
    if before.markets.iter().zip(&before.oracle).any(|(mk, &o)| mk.last_price != 0 && mk.last_price != o) {
        return v;
    }
    // Only where no market's budget can bind on its winners, before or
    // after. Where it can, what a winner is paid depends on the order the
    // book settles in: a loser settling first restores budget a winner then
    // draws on, and a winner settling against a spent budget is cut to a
    // fair share (`haircut_profit_usd`). Either way the payable value of the
    // book moves with no trader losing anything at the mark, and any single
    // valuation of it is only a bound. The budget invariants in
    // `check_state` cover that regime instead.
    let budget_can_bind = |s: &Snap| {
        s.markets.iter().enumerate().any(|(m, mk)| {
            let price = s.oracle[m];
            let winners = mk.side_winners_usd(true, price).unwrap_or(u64::MAX) as u128
                + mk.side_winners_usd(false, price).unwrap_or(u64::MAX) as u128;
            mk.has_open_interest() && winners >= mk.remaining_budget_usd() as u128
        })
    };
    if budget_can_bind(before) || budget_can_bind(after) {
        return v;
    }
    let (lb, tb, ob) = value_split(before);
    let (la, ta, oa) = value_split(after);
    let delta = (la - lb) + (ta - tb) + (oa - ob);
    let positions: i128 = (0..after.markets.len())
        .map(|m| after.open_positions(m).count() + before.open_positions(m).count())
        .sum::<usize>() as i128;
    let slack = aggregate_slack(before).max(aggregate_slack(after)) + 4 * positions + 4;
    ensure!(
        v,
        delta <= slack,
        "lp_value_rises_only_against_a_loss",
        "lp {} -> {} ({:+}), traders {:+}, others {:+}: {delta:+} appeared (slack {slack})",
        lb,
        la,
        la - lb,
        ta - tb,
        oa - ob
    );
    v
}

/// The rounding the side aggregates may carry against the positions, at the
/// oracle: one unit of average entry per side, scaled to the side's size.
fn aggregate_slack(s: &Snap) -> i128 {
    s.markets
        .iter()
        .enumerate()
        .map(|(m, mk)| {
            let price = s.oracle[m] as i128;
            [(mk.long_size_usd, mk.long_avg_entry_price), (mk.short_size_usd, mk.short_avg_entry_price)]
                .iter()
                .filter(|(sz, _)| *sz > 0)
                .map(|&(sz, avg)| 2 * (sz as i128) * price / (avg.max(1) as i128) / (avg.max(1) as i128) + 2)
                .sum::<i128>()
        })
        .sum()
}

/// A deposit or a claim never takes value from the LPs who stay: their
/// shares are worth at least as much after it as before, at the oracle
/// with funding brought up to now. A deposit is priced at whichever of the
/// oracle and risk price makes the pool worth more, and a claim at whichever
/// makes it worth less (`aum::lp_pnl_against_the_mover`), so either way the
/// mover pays the difference.
///
/// Checked under both of the program's readings. A deposit pays at least
/// the deposit-side value per share, which is never below the claim-side
/// one; a claim is paid at most the claim-side value, never above the
/// deposit-side one. So neither reading of the stayers' shares may fall.
pub fn check_no_dilution(what: &str, before: &Snap, after: &Snap) -> Vec<Violation> {
    let mut v = vec![];
    let (sb, sa) = (lp_shares(before), lp_shares(after));
    if sb == 0 || sa == 0 {
        return v;
    }
    for how in [Valuation::Deposit, Valuation::Claim] {
        let (vb, va) = (lp_value(before, how), lp_value(after, how));
        // va / sa >= vb / sb, cross-multiplied. Rounding the shares minted
        // or the USDC paid is worth at most one unit of value per share of
        // the other side of the trade, which is the slack.
        let slack = sb.max(sa);
        ensure!(
            v,
            va * sb + slack >= vb * sa,
            "lp_share_price_not_diluted",
            "{what} ({how:?} reading): value {vb} over {sb} shares became {va} over {sa} (per share {:.9} -> {:.9})",
            vb as f64 / sb as f64,
            va as f64 / sa as f64
        );
    }
    v
}

/// After a backer leaves, what is left of the market's budget is at most
/// the backing still behind it: the budget follows the money out
/// (`backing::book_unback`). No custodies are listed here, so the cover is
/// the USDC backing alone.
pub fn check_unback(after: &Snap, m: usize) -> Vec<Violation> {
    let mut v = vec![];
    let mk = &after.markets[m];
    ensure!(v, mk.remaining_budget_usd() <= mk.backing_usd, "budget_follows_backing_out",
        "market[{m}] remaining budget {} > backing {}", mk.remaining_budget_usd(), mk.backing_usd);
    v
}
