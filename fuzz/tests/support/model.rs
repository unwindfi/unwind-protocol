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
//!
//! Three layers of checks:
//!
//! - `check_state`, on every state a landed transaction leaves: solvency to
//!   the unit, conservation of every token, the totals the pool and markets
//!   keep against the accounts they summarize, the budget.
//! - `check_tx`, on every landed transaction against the state before it:
//!   the fee split to the unit, rewards out of the protocol's cut only, the
//!   order a loss is paid in, points that never fall.
//! - checks around particular actions: funding, LP dilution, a split, a
//!   replayed transaction, and settling or clearing in another order on a
//!   copy of the world.

use super::env::*;
use anchor_lang::prelude::Pubkey;
use anchor_lang::{AnchorDeserialize, Discriminator};
use proptest::prelude::*;
use solana_keypair::Keypair;
use solana_signer::Signer;
use std::collections::BTreeMap;
use std::fmt;
use unwind::constants::*;
use unwind::math::{bps_of, funding_owed_usd, position_pnl_usd};
use unwind::state::{Batch, BackingBook, Custody, LpTokenClaim, Market, Order, Pool, Position, Trader};

const BPS_I: i128 = BPS as i128;
type Ix = (anchor_lang::solana_program::instruction::Instruction, Keypair);

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
    /// Waits out the batch interval and clears. `permute` first clears a
    /// copy of the world with the resting orders in another order and
    /// compares.
    Clear { market: u8, permute: bool },
    /// Settles the `nth` active order of a sealed batch.
    SettleOne { market: u8, nth: u8 },
    /// Settles every active order of a sealed batch, starting from `start`.
    SettleAll { market: u8, start: u8 },
    /// Clear then settle everything: one tick of the crank. `reorder` also
    /// settles a copy of the world in reverse and compares.
    Crank { market: u8, reorder: bool },
    /// Moves a market's mark by `bps`, one second later.
    MovePrice { market: u8, bps: i16 },
    /// A resting maker order and an opposing taker from another trader, same
    /// size, then a crank: two traders crossing each other with the pool
    /// out of it, which the random mix alone rarely lines up.
    /// `checks` cranks with the ordering checks: clearing a copy with the
    /// orders reversed, and settling a copy in reverse.
    Cross { maker: u8, taker: u8, market: u8, maker_long: bool, size_usd: u32, lev_x: u8, crank: bool, checks: bool },
    /// Gaps the mark `bps` against the `nth` open position in the market
    /// and lets the risk price catch up: the setup for a liquidation, or for
    /// a bankrupt one when the gap is past the collateral. `liquidate` then
    /// tries to liquidate it. `favor` moves it the position's way instead,
    /// making a winner.
    Shock { nth: u8, market: u8, bps: u16, liquidate: bool, favor: bool },
    /// Moves the clock. `repost` has the relay post fresh prices after it;
    /// without, prices may go stale and reads are refused.
    Warp { secs: u16, repost: bool },
    /// Steps the risk price toward the mark `times` times, three slots apart.
    StepRisk { market: u8, times: u8 },
    AccrueFunding { market: u8 },
    /// Liquidates the `nth` open position in the market. `catch_up` first
    /// steps the risk price until it reaches the mark, as a keeper would
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
    /// Escrows everything, waits, and claims as much as the pool lets go.
    LpDrain { lp: u8 },
    /// Backs a market with `usd` dollars of `asset`: 0 USDC, 1 and 2 the
    /// custodies (a stable and an oracle-priced token).
    Back { backer: u8, market: u8, usd: u32, asset: u8 },
    /// Withdraws `pct` percent of the backer's shares.
    Unback { backer: u8, market: u8, pct: u8 },
    SyncBacking { market: u8 },
    MarkBacking { backer: u8, market: u8 },
    /// Moves the oracle-priced custody's price by `bps`.
    CustodyPrice { bps: i16 },
    /// Pulls what an LP's withdrawal claims are owed from a custody.
    ClaimTokens { lp: u8, custody: u8 },

    // --- trigger orders
    /// Places a trigger in `slot`: an open (a limit) or a close (a stop or
    /// take-profit), `trigger_bps` from the mark, expiring after `expiry`
    /// seconds (zero: never).
    PlaceTrigger {
        trader: u8,
        market: u8,
        slot: u8,
        open: bool,
        long: bool,
        size_usd: u32,
        lev_x: u8,
        trigger_bps: i16,
        above: bool,
        expiry: u16,
    },
    /// Fires the `nth` trigger standing in the market, first moving the mark
    /// through it when `through`, then cranks when `crank`.
    ExecTrigger { nth: u8, market: u8, through: bool, crank: bool },
    CancelTrigger { nth: u8 },

    // --- admin, mid-flight
    /// Pauses every market on the feed, applies `ratio` (see `split_ratio`),
    /// moves the mark with it, and unpauses.
    Split { market: u8, ratio: u8 },
    PauseMarket { market: u8, paused: bool },
    /// Pauses the pool, tries an order, unpauses.
    PoolPauseBlip { trader: u8, market: u8 },
    /// Lowers the budget to `pct` percent of what it is (past 100: refused).
    SetBudget { market: u8, pct: u8 },
    SetSession { market: u8, session: u8 },
    /// Re-sends the market's parameters with one changed (see
    /// `tweak_params`).
    UpdateParams { market: u8, field: u8, value: u16 },
    /// Collects `pct` percent of the protocol's line, or sweeps the chain's.
    CollectFees { protocol: bool, pct: u8 },
    FundInsurance { usd: u32 },
    /// Tries to deleverage the `nth` open position: a retired path that must
    /// refuse every position.
    Adl { nth: u8, market: u8 },
    /// Hands the pool to a trader and back.
    AuthorityRoundTrip { via: u8 },
    SetPoints { enabled: bool },
    /// Removes the mark keeper, tries a push, puts it back.
    KeeperBlip { market: u8 },
    /// `resize_*` on accounts already at full size: no-ops.
    Resize { which: u8 },

    // --- observed markets
    Observe { market: u8, times: u8 },
    /// Thins an observed market's pool to `pct` percent of its depth, reads
    /// it over a few intervals, and tries to cut the budget to it.
    ThinPool { market: u8, pct: u8 },
    DeriveBudget { market: u8 },

    // --- markets and batches
    /// Lists the next generation of a Pyth feed, by the authority or, with
    /// `lister` past zero, by that trader within the permissionless bounds;
    /// opens its batch and backs it.
    ListGeneration { feed: u8, lister: u8 },
    /// Fills a market's batch: four small orders from every wallet until
    /// it refuses, then cranks the lot.
    FillBatch { market: u8, maker: bool },

    // --- referrals and points
    CreateTrader { who: u8 },
    ClaimCode { who: u8, code: u8 },
    SetReferrer { trader: u8, code: u8 },
    SyncReferral { trader: u8 },
    SyncDeployer { market: u8 },
    ClaimRewards { who: u8 },
    AccruePoints { who: u8, show_lp: bool },
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

/// `(numerator, denominator)` the price is multiplied by.
pub fn split_ratio(r: u8) -> (u64, u64) {
    [(1, 2), (1, 4), (2, 1), (3, 2), (1, 10), (5, 1)][r as usize % 6]
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

fn small() -> std::ops::Range<u8> {
    0u8..8
}

/// The trading core the first harness drove, weighted as it was.
fn core_strategy() -> impl Strategy<Value = Action> {
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
        3 => (small(), prop::bool::weighted(0.3)).prop_map(|(market, permute)| Action::Clear { market, permute }),
        2 => (small(), any::<u8>()).prop_map(|(market, nth)| Action::SettleOne { market, nth }),
        3 => (small(), any::<u8>()).prop_map(|(market, start)| Action::SettleAll { market, start }),
        8 => (small(), prop::bool::weighted(0.25)).prop_map(|(market, reorder)| Action::Crank { market, reorder }),
        8 => (small(), move_strategy()).prop_map(|(market, bps)| Action::MovePrice { market, bps }),
        4 => (small(), small(), 300u16..=9_000, prop::bool::weighted(0.7), prop::bool::weighted(0.35))
            .prop_map(|(nth, market, bps, liquidate, favor)| Action::Shock { nth, market, bps, liquidate, favor }),
        5 => ((small(), small(), small(), any::<bool>()), (size_strategy(), lev_strategy(), prop::bool::weighted(0.8), prop::bool::weighted(0.5)))
            .prop_map(|((maker, taker, market, maker_long), (size_usd, lev_x, crank, checks))| Action::Cross {
                maker, taker, market, maker_long, size_usd, lev_x, crank, checks
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
        2 => (small(), small(), 1u32..200_000, prop::sample::select(vec![0u8, 0, 1, 2]))
            .prop_map(|(backer, market, usd, asset)| Action::Back { backer, market, usd, asset }),
        2 => (small(), small(), 1u8..=100).prop_map(|(backer, market, pct)| Action::Unback { backer, market, pct }),
    ]
}

/// Everything the first harness did not drive: triggers, splits, custodies,
/// referrals, admin changes mid-flight, observed markets, generations, full
/// batches.
fn extra_strategy() -> impl Strategy<Value = Action> {
    let trig = (
        (small(), small(), 0u8..ORDER_SLOTS, prop::bool::weighted(0.4), any::<bool>()),
        (size_strategy(), lev_strategy(), -1_500i16..=1_500, any::<bool>(), prop_oneof![3 => Just(0u16), 1 => 1u16..900]),
    )
        .prop_map(|((trader, market, slot, open, long), (size_usd, lev_x, trigger_bps, above, expiry))| {
            Action::PlaceTrigger { trader, market, slot, open, long, size_usd, lev_x, trigger_bps, above, expiry }
        });
    let custody = prop_oneof![
        2 => small().prop_map(|market| Action::SyncBacking { market }),
        1 => (small(), small()).prop_map(|(backer, market)| Action::MarkBacking { backer, market }),
        2 => move_strategy().prop_map(|bps| Action::CustodyPrice { bps }),
        2 => (small(), small()).prop_map(|(lp, custody)| Action::ClaimTokens { lp, custody }),
        1 => small().prop_map(|lp| Action::LpDrain { lp }),
    ];
    let admin = prop_oneof![
        2 => (small(), any::<u8>()).prop_map(|(market, ratio)| Action::Split { market, ratio }),
        2 => (small(), any::<bool>()).prop_map(|(market, paused)| Action::PauseMarket { market, paused }),
        1 => (small(), small()).prop_map(|(trader, market)| Action::PoolPauseBlip { trader, market }),
        1 => (small(), 0u8..=110).prop_map(|(market, pct)| Action::SetBudget { market, pct }),
        1 => (small(), 0u8..4).prop_map(|(market, session)| Action::SetSession { market, session }),
        2 => (small(), any::<u8>(), any::<u16>()).prop_map(|(market, field, value)| Action::UpdateParams { market, field, value }),
        1 => (any::<bool>(), 1u8..=100).prop_map(|(protocol, pct)| Action::CollectFees { protocol, pct }),
        1 => (1u32..20_000).prop_map(|usd| Action::FundInsurance { usd }),
        1 => (small(), small()).prop_map(|(nth, market)| Action::Adl { nth, market }),
        1 => small().prop_map(|via| Action::AuthorityRoundTrip { via }),
        1 => any::<bool>().prop_map(|enabled| Action::SetPoints { enabled }),
        1 => small().prop_map(|market| Action::KeeperBlip { market }),
        1 => small().prop_map(|which| Action::Resize { which }),
    ];
    let observed = prop_oneof![
        2 => (small(), 1u8..6).prop_map(|(market, times)| Action::Observe { market, times }),
        1 => (small(), 1u8..=100).prop_map(|(market, pct)| Action::ThinPool { market, pct }),
        1 => small().prop_map(|market| Action::DeriveBudget { market }),
    ];
    let markets = prop_oneof![
        1 => (0u8..5, 0u8..4).prop_map(|(feed, lister)| Action::ListGeneration { feed, lister }),
        1 => (small(), prop::bool::weighted(0.7)).prop_map(|(market, maker)| Action::FillBatch { market, maker }),
    ];
    let referral = prop_oneof![
        1 => any::<u8>().prop_map(|who| Action::CreateTrader { who }),
        2 => (any::<u8>(), 0u8..=N_CODES).prop_map(|(who, code)| Action::ClaimCode { who, code }),
        2 => (small(), 0u8..=N_CODES).prop_map(|(trader, code)| Action::SetReferrer { trader, code }),
        2 => small().prop_map(|trader| Action::SyncReferral { trader }),
        2 => small().prop_map(|market| Action::SyncDeployer { market }),
        2 => any::<u8>().prop_map(|who| Action::ClaimRewards { who }),
        1 => (any::<u8>(), prop::bool::weighted(0.7)).prop_map(|(who, show_lp)| Action::AccruePoints { who, show_lp }),
    ];
    prop_oneof![
        6 => trig,
        5 => (small(), small(), prop::bool::weighted(0.6), prop::bool::weighted(0.6))
            .prop_map(|(nth, market, through, crank)| Action::ExecTrigger { nth, market, through, crank }),
        1 => small().prop_map(|nth| Action::CancelTrigger { nth }),
        6 => custody,
        8 => admin,
        3 => observed,
        2 => markets,
        8 => referral,
    ]
}

pub fn action_strategy(fixture: Fixture) -> BoxedStrategy<Action> {
    match fixture {
        Fixture::Main => prop_oneof![84 => core_strategy(), 39 => extra_strategy()].boxed(),
        // Bad debt is what the thin pool is for: more gaps, more exits by
        // the LPs, more favorable shocks.
        Fixture::Thin => prop_oneof![
            84 => core_strategy(),
            30 => extra_strategy(),
            6 => small().prop_map(|lp| Action::LpDrain { lp }),
            8 => (small(), small(), 3_000u16..=20_000, prop::bool::weighted(0.5), prop::bool::weighted(0.6))
                .prop_map(|(nth, market, bps, liquidate, favor)| Action::Shock { nth, market, bps, liquidate, favor }),
        ]
        .boxed(),
    }
}

// ------------------------------------------------------------------ snapshot

/// Everything the invariants read, taken at one instant.
#[derive(Clone)]
pub struct Snap {
    pub pool: Pool,
    pub market_keys: Vec<Pubkey>,
    pub markets: Vec<Market>,
    pub batches: Vec<Batch>,
    /// `positions[m][t]`, `None` where the account does not exist.
    pub positions: Vec<Vec<Option<Position>>>,
    pub vault: u64,
    pub usdc_supply: u64,
    pub lp_supply: u64,
    /// Every wallet the harness funds, in `Env::owners` order.
    pub owner_keys: Vec<Pubkey>,
    pub owner_usdc: Vec<u64>,
    /// Their `Trader` records.
    pub records: Vec<Option<Trader>>,
    /// Every USDC balance the harness knows outside the vault.
    pub wallets_usdc: u64,
    pub trader_usdc: Vec<u64>,
    pub authority_usdc: u64,
    pub lp_balances: u64,
    pub lp_escrows: u64,
    pub now: i64,
    pub oracle: Vec<u64>,
    /// Trigger orders standing, by `(trader, market, slot)`.
    pub orders: Vec<((usize, usize, u8), Order)>,
    pub custodies: Vec<Custody>,
    pub custody_vaults: Vec<u64>,
    pub custody_supply: Vec<u64>,
    pub custody_wallets: Vec<u64>,
    pub custody_prices: Vec<u64>,
    pub books: Vec<Option<BackingBook>>,
    pub token_claims: Vec<Option<LpTokenClaim>>,
}

impl Snap {
    pub fn take(env: &Env) -> Snap {
        let n = env.markets.len();
        let markets: Vec<Market> = (0..n).map(|m| env.market_state(m)).collect();
        let batches = (0..n).map(|m| env.batch_state(m)).collect();
        let positions = (0..n)
            .map(|m| env.traders.iter().map(|k| env.position_state(m, &k.pubkey())).collect())
            .collect();
        let owner_keys = env.owners();
        let owner_usdc: Vec<u64> = owner_keys.iter().map(|o| env.usdc_of(o)).collect();
        let orders = env
            .trigger_keys
            .iter()
            .filter_map(|&(t, m, s)| env.order_state(t, m, s).map(|o| ((t, m, s), o)))
            .collect();
        let custodies: Vec<Custody> = (0..env.custodies.len()).map(|i| env.custody_state(i)).collect();
        Snap {
            pool: env.pool_state(),
            market_keys: env.markets.iter().map(|fx| fx.market).collect(),
            markets,
            batches,
            positions,
            vault: env.token_balance(&env.vault),
            usdc_supply: env.mint_supply(&env.usdc_mint),
            lp_supply: env.mint_supply(&env.lp_mint),
            records: owner_keys.iter().map(|o| env.trader_state(o)).collect(),
            wallets_usdc: owner_usdc.iter().sum(),
            owner_usdc,
            owner_keys: owner_keys.clone(),
            trader_usdc: env.traders.iter().map(|k| env.usdc_of(&k.pubkey())).collect(),
            authority_usdc: env.usdc_of(&env.authority.pubkey()),
            lp_balances: env.lps.iter().map(|k| env.lp_of(&k.pubkey())).sum(),
            lp_escrows: env.lps.iter().map(|k| env.token_balance(&env.withdraw_escrow(&k.pubkey()))).sum(),
            now: env.clock().unix_timestamp,
            oracle: (0..n).map(|m| env.oracle_price(m)).collect(),
            orders,
            custody_vaults: env.custodies.iter().map(|c| env.token_balance(&c.vault)).collect(),
            custody_supply: env.custodies.iter().map(|c| env.mint_supply(&c.mint)).collect(),
            custody_wallets: env
                .custodies
                .iter()
                .map(|c| owner_keys.iter().map(|o| env.token_balance(&token_account_address(o, &c.mint))).sum())
                .collect(),
            custody_prices: env.custodies.iter().map(|c| c.price).collect(),
            custodies,
            books: (0..n).map(|m| env.book_state(m)).collect(),
            token_claims: env.lps.iter().map(|k| env.anchor(&env.token_claim_address(&k.pubkey()))).collect(),
        }
    }

    fn open_positions(&self, m: usize) -> impl Iterator<Item = &Position> {
        self.positions[m].iter().flatten().filter(|p| p.is_open())
    }

    fn market_index(&self, key: &Pubkey) -> Option<usize> {
        self.market_keys.iter().position(|k| k == key)
    }

    fn owner_index(&self, key: &Pubkey) -> Option<usize> {
        self.owner_keys.iter().position(|k| k == key)
    }

    /// What the LPs hold in kind, at the custodies' prices.
    fn lp_in_kind_usd(&self) -> i128 {
        self.custodies
            .iter()
            .zip(&self.custody_prices)
            .map(|(c, &p)| unwind::state::token_value_usd(c.lp_amount, p, c.decimals).unwrap_or(0) as i128)
            .sum()
    }

    /// What market `m`'s in-kind backing counts toward its budget.
    fn in_kind_weighted(&self, m: usize) -> u128 {
        let Some(b) = &self.books[m] else { return 0 };
        self.custodies
            .iter()
            .zip(&self.custody_prices)
            .map(|(c, &p)| {
                let v = unwind::state::token_value_usd(b.amounts[c.index as usize], p, c.decimals).unwrap_or(0) as u128;
                v * c.budget_weight_bps as u128 / BPS
            })
            .sum()
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

    // Custody tokens: each vault holds exactly the backers' tokens, the LPs',
    // what claims are owed and the fund's; the backers' tokens are the books'
    // sum; the claims owed are the LPs' token claims; and no token is made or
    // lost.
    for (i, c) in s.custodies.iter().enumerate() {
        let held = c.backing_amount as u128 + c.lp_amount as u128 + c.lp_owed_amount as u128 + c.insurance_amount as u128;
        ensure!(v, s.custody_vaults[i] as u128 == held, "custody_vault_reconciles",
            "custody {i}: vault {} != backing {} + lp {} + owed {} + fund {}", s.custody_vaults[i], c.backing_amount,
            c.lp_amount, c.lp_owed_amount, c.insurance_amount);
        let in_books: u128 = s.books.iter().flatten().map(|b| b.amounts[c.index as usize] as u128).sum();
        ensure!(v, in_books == c.backing_amount as u128, "custody_backing_is_book_sum",
            "custody {i}: backing_amount {} != sum over books {in_books}", c.backing_amount);
        let owed: u128 = s.token_claims.iter().flatten().map(|t| t.owed[c.index as usize] as u128).sum();
        ensure!(v, owed == c.lp_owed_amount as u128, "custody_owed_is_claim_sum",
            "custody {i}: lp_owed_amount {} != sum of LP token claims {owed}", c.lp_owed_amount);
        ensure!(v, s.custody_supply[i] as u128 == s.custody_vaults[i] as u128 + s.custody_wallets[i] as u128,
            "custody_tokens_conserved", "custody {i}: supply {} != vault {} + wallets {}",
            s.custody_supply[i], s.custody_vaults[i], s.custody_wallets[i]);
    }

    // Rewards: the vault's rewards line is exactly what wallets may claim,
    // what referees owe their referrers, and what markets owe deployers.
    let owed_rewards: u128 = s
        .records
        .iter()
        .flatten()
        .map(|t| t.rewards_usd as u128 + t.referrer_rewards_owed as u128)
        .sum::<u128>()
        + s.markets.iter().map(|m| m.deployer_rewards_usd as u128).sum::<u128>();
    ensure!(v, owed_rewards == p.rewards_usd as u128, "rewards_line_is_what_is_owed",
        "pool.rewards_usd {} != wallets' and markets' rewards {owed_rewards}", p.rewards_usd);

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
        // until a split. A split empties them and untracks the positions
        // open across it (`rescale_market`), so after one they track at most
        // the side, and exactly the positions opened or topped up since.
        for (side, size, mom, fun) in [
            ("long", mk.long_size_usd, mk.long_moments.tracked_usd, mk.long_funding.tracked_usd),
            ("short", mk.short_size_usd, mk.short_moments.tracked_usd, mk.short_funding.tracked_usd),
        ] {
            if mk.split_epoch == 0 {
                ensure!(v, mom == size, "moments_track_every_position",
                    "market[{m}] {side}: moments track {mom} of {size}");
                ensure!(v, fun == size, "moments_track_every_position",
                    "market[{m}] {side}: funding sums track {fun} of {size}");
            } else {
                ensure!(v, mom <= size, "moments_track_at_most_the_side",
                    "market[{m}] {side}: moments track {mom} of {size} after a split");
            }
        }


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
                // Only where the side's moment sums track all of it. After a
                // split, a side still holding positions from before it counts
                // winners at its net profit (`Market::side_winners_usd`, the
                // documented old rule), which a loser on the same side hides
                // a winner behind until those positions close.
                if let Some(bound) = mk.side_winners_bound_usd(is_long, price) {
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
                    .map(|&(sz, avg)| {
                        split_amplification(mk) * (2 * (sz as i128) * (price as i128) / (avg.max(1) as i128) / (avg.max(1) as i128) + 2)
                    })
                    .sum::<i128>()
                    + n_open as i128;
                // After a split the aggregate is the documented old rule and
                // may drift without bound as large positions leave (see
                // `split_drift`); there it is measured, not enforced.
                if mk.split_epoch == 0 {
                    ensure!(v, (agg as i128 - sum).abs() <= slack, "aggregate_pnl_matches_positions",
                        "market[{m}] at {price}: aggregate {agg} vs positions {sum} (slack {slack})");
                } else if (agg as i128 - sum).abs() > slack + split_drift(mk, price) {
                    v.push(Violation {
                        invariant: "post_split_aggregate_drift",
                        detail: format!("market[{m}] at {price}: aggregate {agg} vs positions {sum}"),
                    });
                }
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
    // Escrow is what resting opens in the batches and open triggers posted.
    let escrow: u128 = s
        .batches
        .iter()
        .flat_map(|b| b.orders.iter())
        .filter(|o| o.is_active() && !o.reduces())
        .map(|o| o.collateral_usd as u128)
        .sum::<u128>()
        + s.orders.iter().map(|(_, o)| o.collateral_usd as u128).sum::<u128>();
    ensure!(v, escrow == p.escrow_usd as u128, "escrow_is_resting_collateral",
        "pool.escrow_usd {} != collateral on resting opens and open triggers {escrow}", p.escrow_usd);
    ensure!(v, with_oi == p.markets_with_oi, "markets_with_oi_counted",
        "pool.markets_with_oi {} but {with_oi} markets carry open interest", p.markets_with_oi);
    ensure!(v, drift == p.aum_drift_usd, "pool_drift_is_market_sum",
        "pool.aum_drift_usd {} != sum over markets with open interest {drift}", p.aum_drift_usd);
    v
}

// ------------------------------------------------------------------ events

/// The events a landed transaction emitted, raw.
pub struct Events(Vec<([u8; 8], Vec<u8>)>);

impl Events {
    fn parse(logs: &[String]) -> Events {
        use base64::Engine;
        let mut out = vec![];
        for l in logs {
            let Some(b64) = l.strip_prefix("Program data: ") else { continue };
            let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(b64.split(' ').next().unwrap_or("")) else {
                continue;
            };
            if bytes.len() < 8 {
                continue;
            }
            out.push((bytes[..8].try_into().unwrap(), bytes[8..].to_vec()));
        }
        Events(out)
    }

    fn all<T: AnchorDeserialize + Discriminator>(&self) -> Vec<T> {
        self.0
            .iter()
            .filter(|(d, _)| d[..] == *T::DISCRIMINATOR)
            .filter_map(|(_, b)| T::deserialize(&mut &b[..]).ok())
            .collect()
    }

    fn has<T: Discriminator>(&self) -> bool {
        self.0.iter().any(|(d, _)| d[..] == *T::DISCRIMINATOR)
    }
}

use unwind::instructions::{
    BackerFeePaid, BackingPaidLps, BackingRefunded, BackingRepaidFund, BatchCleared, BudgetDerived, CorporateActionApplied, FeeRewards, FundTokensSoldToLps,
    InsuranceDrawn, InsuranceRepaid, LiquidityOwedInKind, MarkObserved, MarkPushed, OrderExpired, OrderSettled, OrderTriggered,
    PositionClosed, PositionLiquidated, ProfitHaircut, RewardsClaimed,
};

/// Counts the events a landed transaction emitted that say which path it
/// took.
fn record_events(stats: &mut Stats, ev: &Events) {
    let c = &mut stats.coverage;
    let mut bump = |k: &'static str| *c.entry(k).or_default() += 1;
    if ev.has::<ProfitHaircut>() {
        bump("event: profit haircut");
    }
    if ev.has::<InsuranceDrawn>() {
        bump("event: insurance drawn");
    }
    if ev.has::<InsuranceRepaid>() {
        bump("event: a batch put back what the fund paid its winners");
    }
    for e in ev.all::<PositionClosed>() {
        bump(if e.pnl_usd > 0 { "event: close in profit" } else { "event: close at a loss" });
    }
    for e in ev.all::<PositionLiquidated>() {
        bump(if e.returned_usd == 0 { "event: liquidation, owner wiped out" } else { "event: liquidation, owner paid back" });
    }
    for e in ev.all::<BatchCleared>() {
        if e.buy_matched_usd > 0 || e.sell_matched_usd > 0 {
            bump("event: batch crossed");
        }
        if e.pool_bought > 0 || e.pool_sold > 0 {
            bump("event: pool filled");
        }
        if (e.buy_matched_usd > e.pool_sold) || (e.sell_matched_usd > e.pool_bought) {
            bump("event: trader crossed trader");
        }
        if e.orders as usize == unwind::auction::MAX_BATCH_ORDERS {
            bump("event: full batch of 64 cleared");
        }
    }
    for e in ev.all::<OrderTriggered>() {
        bump(if e.is_bid { "event: trigger fired, buy" } else { "event: trigger fired, sell" });
    }
    if ev.has::<OrderExpired>() {
        bump("event: trigger expired");
    }
    if ev.has::<CorporateActionApplied>() {
        bump("event: split applied");
    }
    if ev.has::<BackingPaidLps>() {
        bump("event: in-kind backing paid the LPs");
    }
    if ev.has::<BackingRefunded>() {
        bump("event: in-kind backing refunded");
    }
    for e in ev.all::<BackingRepaidFund>() {
        if e.in_kind_usd > 0 {
            bump("event: in-kind backing repaid the fund in tokens");
        }
        if e.usdc_usd > 0 {
            bump("event: LPs passed tokens they no longer bore to the fund");
        }
    }
    if ev.has::<FundTokensSoldToLps>() {
        bump("event: LPs bought the fund's tokens");
    }
    if ev.has::<LiquidityOwedInKind>() {
        bump("event: LP claim owed tokens in kind");
    }
    if ev.has::<RewardsClaimed>() {
        bump("event: rewards claimed");
    }
    for e in ev.all::<FeeRewards>() {
        if e.to_referrer_usd > 0 {
            bump("event: fee paid a referrer");
        }
        if e.to_deployer_usd > 0 {
            bump("event: fee paid a deployer");
        }
        if e.discount_usd > 0 {
            bump("event: fee discounted");
        }
    }
    if ev.has::<MarkPushed>() {
        bump("event: keeper mark pushed");
    }
    for e in ev.all::<MarkObserved>() {
        bump(if e.clamped { "event: observed mark clamped" } else { "event: observed mark folded" });
    }
    if ev.has::<BudgetDerived>() {
        bump("event: budget cut to depth");
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
        if mk.split_epoch > 0 && mk.has_open_interest() {
            *c.entry("state: positions open after a split").or_default() += 1;
        }
        let valued = unwind::aum::accrued_to(mk, &s.pool, s.now).expect("accrue");
        if s.open_positions(m).any(|q| position_terms(&valued, q, s.oracle[m]).2 < 0) {
            *c.entry("state: a position past its collateral").or_default() += 1;
        }
    }
    if s.custodies.iter().any(|c| c.lp_amount > 0) {
        *c.entry("state: LPs hold tokens in kind").or_default() += 1;
    }
    if s.pool.liquidity_usd == 0 {
        *c.entry("state: LP liquidity at zero").or_default() += 1;
    }
    if !s.orders.is_empty() {
        *c.entry("state: trigger orders standing").or_default() += 1;
    }
}

/// Checks across one landed transaction, from the state before it.
fn check_tx(label: &str, b: &Snap, a: &Snap, ev: &Events) -> Vec<Violation> {
    let mut v = vec![];
    let (pb, pa) = (&b.pool, &a.pool);
    let d = |x: u64, y: u64| y as i128 - x as i128;
    let d_prot = d(pb.protocol_fees_usd, pa.protocol_fees_usd);
    let d_rew = d(pb.rewards_usd, pa.rewards_usd);
    let d_chain = d(pb.chain_fees_usd, pa.chain_fees_usd);
    let d_ins = d(pb.insurance_usd, pa.insurance_usd);
    let d_back = d(pb.backing_usd, pa.backing_usd);
    let d_liq = d(pb.liquidity_usd, pa.liquidity_usd);
    let drawn: u64 = ev.all::<InsuranceDrawn>().iter().map(|e| e.amount_usd).sum();
    // What a loser's gain put back of what the fund paid a winner earlier in
    // the same batch: part of the fund's line that is not a fee cut.
    let put_back: u64 = ev.all::<InsuranceRepaid>().iter().map(|e| e.amount_usd).sum();
    let share = pb.protocol_fee_share_bps;
    let cut = |fee: u64, bps: u16| bps_of(fee, bps).unwrap() as i128;

    // The order a loss is paid in (docs/loss-budget.md): backing, then LP
    // liquidity, then the fund, and the fund only for what liquidity cannot
    // cover. So the fund falls only in a settlement or liquidation, only
    // when that left LP liquidity at nothing, and only on a market whose
    // backing is gone.
    if pa.insurance_usd < pb.insurance_usd {
        ensure!(v, label == "settle_order" || label == "liquidate", "insurance_drawn_only_by_a_loss",
            "{label} took the fund from {} to {}", pb.insurance_usd, pa.insurance_usd);
        ensure!(v, pa.liquidity_usd == 0, "insurance_drawn_after_liquidity",
            "{label}: fund drawn {} with LP liquidity {} left", pb.insurance_usd - pa.insurance_usd, pa.liquidity_usd);
        let payer = (0..b.markets.len()).find(|&m| a.markets[m].net_loss_usd > b.markets[m].net_loss_usd);
        match payer {
            Some(m) => ensure!(v, a.markets[m].backing_usd == 0, "insurance_drawn_after_backing",
                "{label}: fund drawn while market[{m}] still has backing {}", a.markets[m].backing_usd),
            None => v.push(Violation {
                invariant: "insurance_drawn_after_backing",
                detail: format!("{label}: fund drawn with no market's loss rising"),
            }),
        }
        ensure!(v, drawn as i128 == -d_ins, "insurance_draw_reported",
            "{label}: fund fell {} but InsuranceDrawn says {drawn}", -d_ins);
    }

    // The budget: what a market has cost, net, never passes what it was
    // underwritten for when a loss is charged. `charge_loss` refuses past it
    // and every payout path goes through it. (The authority, or a thin pool
    // through `derive_market_budget`, may cut a budget below what a market
    // already lost; that charges nothing, and leaves nothing remaining.)
    for (m, (mb, ma)) in b.markets.iter().zip(&a.markets).enumerate() {
        if ma.net_loss_usd > mb.net_loss_usd {
            ensure!(v, ma.net_loss_usd <= ma.loss_budget_usd as i64, "loss_within_budget",
                "{label}: market[{m}] net loss {} -> {} past its budget {}", mb.net_loss_usd, ma.net_loss_usd, ma.loss_budget_usd);
        }
    }

    // Rewards are carved from the protocol's cut in settlement and nowhere
    // else, and never more of a fee than the protocol's share of it.
    if d_rew > 0 {
        ensure!(v, label == "settle_order", "rewards_only_from_fills", "{label} raised the rewards line by {d_rew}");
    }
    for e in ev.all::<FeeRewards>() {
        let room = bps_of(e.fee_usd, share).unwrap();
        ensure!(v, e.to_referrer_usd + e.to_deployer_usd <= room, "rewards_within_protocol_cut",
            "fee {}: referrer {} + deployer {} > protocol cut {room}", e.fee_usd, e.to_referrer_usd, e.to_deployer_usd);
    }

    // Points and referral counts never fall.
    for (i, (rb, ra)) in b.records.iter().zip(&a.records).enumerate() {
        if let (Some(rb), Some(ra)) = (rb, ra) {
            ensure!(v, ra.points >= rb.points, "points_never_fall", "wallet {i}: points {} -> {}", rb.points, ra.points);
            ensure!(v, ra.referral_count >= rb.referral_count, "points_never_fall",
                "wallet {i}: referral count {} -> {}", rb.referral_count, ra.referral_count);
        }
    }

    // The fee split, to the unit (docs/fees.md): 20% protocol (of which the
    // referrer's and lister's rewards), 10% insurance, 10% chain, and of the
    // rest half to the backers when the market has any, the LPs the rest.
    for e in ev.all::<OrderSettled>() {
        let Some(m) = b.market_index(&e.market) else { continue };
        let order = b.batches[m].orders[e.index as usize];
        let mk = &b.markets[m];
        let rec = b.owner_index(&e.owner).and_then(|i| b.records[i].clone());
        let referred = rec.as_ref().is_some_and(|t| t.has_referrer());
        let is_deployer = e.owner == mk.deployer && mk.deployer != Pubkey::default();
        let discount = if is_deployer { DEPLOYER_DISCOUNT_BPS } else if referred { REFEREE_DISCOUNT_BPS } else { 0 };
        let pays_referrer = referred && !pb.no_points;
        let pays_deployer = !is_deployer && mk.deployer != Pubkey::default();
        let rewards = |fee: u64| {
            let room = bps_of(fee, share).unwrap();
            let r = if pays_referrer { bps_of(fee, REFERRER_FEE_SHARE_BPS).unwrap().min(room) } else { 0 };
            let dd = if pays_deployer { bps_of(fee, DEPLOYER_FEE_SHARE_BPS).unwrap().min(room - r) } else { 0 };
            (r + dd) as i128
        };
        if e.filled_usd > 0 && !order.reduces() {
            let full = bps_of(e.filled_usd, mk.open_fee_bps).unwrap();
            let fee = full - bps_of(full, discount).unwrap();
            let total = d_prot + d_rew + d_chain + d_ins + d_back + d_liq;
            ensure!(v, total == fee as i128, "open_fee_charged",
                "open of {} at {} bps, discount {discount}: lines took {total}, fee is {fee}", e.filled_usd, mk.open_fee_bps);
            ensure!(v, d_prot + d_rew == cut(fee, share), "fee_split_protocol",
                "open fee {fee}: protocol and rewards took {} of {}", d_prot + d_rew, cut(fee, share));
            ensure!(v, d_chain == cut(fee, CHAIN_FEE_SHARE_BPS), "fee_split_chain", "open fee {fee}: chain took {d_chain}");
            ensure!(v, d_ins == cut(fee, pb.insurance_fee_share_bps), "fee_split_insurance", "open fee {fee}: insurance took {d_ins}");
            let lp_fee = fee as i128 - cut(fee, share) - cut(fee, CHAIN_FEE_SHARE_BPS) - cut(fee, pb.insurance_fee_share_bps);
            let to_backers = if mk.backing_shares > 0 { lp_fee * BACKER_FEE_SHARE_BPS as i128 / BPS_I } else { 0 };
            ensure!(v, d_back == to_backers, "fee_split_backers", "open fee {fee}: backers took {d_back}, owed {to_backers}");
            ensure!(v, d_liq == lp_fee - to_backers, "fee_split_lps", "open fee {fee}: LPs took {d_liq}, owed {}", lp_fee - to_backers);
            ensure!(v, d_rew == rewards(fee), "rewards_exact",
                "open fee {fee}: rewards line took {d_rew}, owed {} (referrer {pays_referrer}, deployer {pays_deployer})", rewards(fee));
        }
        if order.reduces() {
            for c in ev.all::<PositionClosed>() {
                let full = bps_of(c.size_usd, mk.close_fee_bps).unwrap();
                ensure!(v, c.fee_usd <= full - bps_of(full, discount).unwrap(), "close_fee_charged",
                    "close of {}: fee {} past the rate's {} after discount {discount}", c.size_usd, c.fee_usd, full);
                // Unclamped: liquidity was never emptied, no fund draw.
                if pa.liquidity_usd > 0 && drawn == 0 {
                    let f = c.fee_usd;
                    ensure!(v, d_prot + d_rew == cut(f, share), "fee_split_protocol",
                        "close fee {f}: protocol and rewards took {}", d_prot + d_rew);
                    ensure!(v, d_chain == cut(f, CHAIN_FEE_SHARE_BPS), "fee_split_chain", "close fee {f}: chain took {d_chain}");
                    ensure!(v, d_ins - put_back as i128 == cut(f, pb.insurance_fee_share_bps), "fee_split_insurance",
                        "close fee {f}: insurance took {d_ins}, {put_back} of it repaid by the batch");
                    ensure!(v, d_rew == rewards(f), "rewards_exact", "close fee {f}: rewards took {d_rew}, owed {}", rewards(f));
                    let lp_fee = f as i128 - cut(f, share) - cut(f, CHAIN_FEE_SHARE_BPS) - cut(f, pb.insurance_fee_share_bps);
                    let paid: i128 = ev.all::<BackerFeePaid>().iter().map(|x| x.amount_usd as i128).sum();
                    // Clamped to the liquidity there was when it was taken,
                    // which is what is left now plus the cut itself.
                    let base = lp_fee.min(pa.liquidity_usd as i128 + paid);
                    let to_backers = if mk.backing_shares > 0 { base * BACKER_FEE_SHARE_BPS as i128 / BPS_I } else { 0 };
                    ensure!(v, paid == to_backers, "fee_split_backers", "close fee {f}: backers took {paid}, owed {to_backers}");
                }
            }
        }
    }

    // A liquidation: the liquidator takes the fee less the three cuts, which
    // stay in the pool (docs/fees.md).
    for e in ev.all::<PositionLiquidated>() {
        let Some(m) = b.market_index(&e.market) else { continue };
        let mk = &b.markets[m];
        let full = bps_of(e.size_usd, mk.liquidation_fee_bps).unwrap();
        let cuts = |fee: u64| (cut(fee, share) + cut(fee, CHAIN_FEE_SHARE_BPS) + cut(fee, pb.insurance_fee_share_bps)) as u64;
        if e.returned_usd > 0 {
            ensure!(v, e.bounty_usd == full - cuts(full), "liquidation_bounty_exact",
                "fee {full}: bounty {} != fee less cuts {}", e.bounty_usd, full - cuts(full));
            if pa.liquidity_usd > 0 && drawn == 0 {
                ensure!(v, d_prot == cut(full, share) && d_chain == cut(full, CHAIN_FEE_SHARE_BPS)
                    && d_ins == cut(full, pb.insurance_fee_share_bps) && d_rew == 0, "liquidation_cuts_exact",
                    "fee {full}: protocol {d_prot} chain {d_chain} insurance {d_ins} rewards {d_rew}");
            }
        } else {
            ensure!(v, e.bounty_usd <= full - cuts(full), "liquidation_bounty_exact",
                "fee at most {full}: bounty {} past it", e.bounty_usd);
        }
        ensure!(v, d(b.authority_usdc, a.authority_usdc) == e.bounty_usd as i128, "liquidation_bounty_paid",
            "bounty {} but the liquidator's wallet moved {}", e.bounty_usd, d(b.authority_usdc, a.authority_usdc));
    }

    // A rewards claim pays exactly what the wallet was owed, out of the
    // rewards line.
    for e in ev.all::<RewardsClaimed>() {
        let i = b.owner_index(&e.owner).expect("owner");
        let owed = b.records[i].as_ref().map_or(0, |t| t.rewards_usd);
        ensure!(v, e.amount_usd == owed && -d_rew == owed as i128 && d(b.owner_usdc[i], a.owner_usdc[i]) == owed as i128,
            "rewards_claim_exact", "owed {owed}: claimed {}, line fell {}, wallet rose {}",
            e.amount_usd, -d_rew, d(b.owner_usdc[i], a.owner_usdc[i]));
    }

    // Collecting the chain's line moves all of it to the fixed destination.
    if label == "collect_chain_fees" {
        ensure!(v, pa.chain_fees_usd == 0 && d(b.authority_usdc, a.authority_usdc) == pb.chain_fees_usd as i128,
            "chain_fees_swept_to_destination", "chain line {} -> {}, destination +{}",
            pb.chain_fees_usd, pa.chain_fees_usd, d(b.authority_usdc, a.authority_usdc));
    }
    // A retired path never lands.
    if label == "auto_deleverage" {
        v.push(Violation { invariant: "adl_refuses_every_position", detail: "auto_deleverage landed".into() });
    }
    v
}

/// Every unit of value a transaction could move, for the replay check.
fn money(s: &Snap) -> Vec<i128> {
    let p = &s.pool;
    let mut out: Vec<i128> = vec![
        s.vault as i128,
        p.liquidity_usd as i128,
        p.backing_usd as i128,
        p.protocol_fees_usd as i128,
        p.chain_fees_usd as i128,
        p.insurance_usd as i128,
        p.trader_collateral_usd as i128,
        p.escrow_usd as i128,
        p.rewards_usd as i128,
        p.locked_usd as i128,
    ];
    out.extend(s.owner_usdc.iter().map(|&x| x as i128));
    out.extend(s.custody_vaults.iter().map(|&x| x as i128));
    out.extend(s.custody_wallets.iter().map(|&x| x as i128));
    for r in &s.records {
        let r = r.as_ref();
        out.push(r.map_or(0, |t| t.rewards_usd as i128));
        out.push(r.map_or(0, |t| t.referrer_rewards_owed as i128));
        out.push(r.map_or(0, |t| t.points as i128));
    }
    for (m, mk) in s.markets.iter().enumerate() {
        out.extend([mk.deployer_rewards_usd as i128, mk.net_loss_usd as i128, mk.backing_usd as i128, mk.collateral_usd as i128]);
        for q in s.positions[m].iter().flatten() {
            out.extend([q.size_usd as i128, q.collateral_usd as i128, q.closing_usd as i128]);
        }
    }
    out
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
/// liquidity and the tokens they hold in kind, less what every market owes
/// after its caps, with funding brought up to now.
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
    s.pool.liquidity_usd as i128 + s.lp_in_kind_usd() - owed
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
/// position's collateral, and rounds) or the aggregate plus a bad-debt bound
/// (which can overstate it).
fn book_split(s: &Snap, m: usize) -> (i128, i128) {
    let mk = &s.markets[m];
    if !mk.has_open_interest() {
        return (0, 0);
    }
    let valued = unwind::aum::accrued_to(mk, &s.pool, s.now).expect("accrue");
    let price = s.oracle[m];
    // Straight from the positions: their PnL less the funding they owe, each
    // loser counted no further than its collateral. Not the side aggregates,
    // which after a split stop counting funding (`Market::trader_net_usd`,
    // the documented old rule) and would show the funding a close then
    // collects as value appearing from nowhere.
    let net: i128 = s
        .open_positions(m)
        .map(|q| {
            let (pnl, funding, equity) = position_terms(&valued, q, price);
            pnl as i128 - funding as i128 + (-equity).max(0)
        })
        .sum::<i128>()
        .clamp(i64::MIN as i128, i64::MAX as i128);
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

impl Stats {
    fn record(&mut self, ix: &'static str, outcome: &TxOutcome) {
        let e = self.per_ix.entry(ix).or_default();
        match outcome {
            TxOutcome::Ok => e.0 += 1,
            TxOutcome::Rejected { name, .. } => *e.1.entry(name.clone()).or_default() += 1,
            TxOutcome::Aborted { reason, .. } => *e.1.entry(format!("ABORT {reason}")).or_default() += 1,
        }
    }

    fn cover(&mut self, k: &'static str) {
        *self.coverage.entry(k).or_default() += 1;
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

    pub fn ok(&self, ix: &str) -> u64 {
        self.per_ix.get(ix).map_or(0, |e| e.0)
    }
}

impl fmt::Display for Stats {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        writeln!(f, "{} actions", self.steps)?;
        for (k, n) in &self.coverage {
            writeln!(f, "  {k:<48} {n:>9}")?;
        }
        for (k, (ok, rej)) in &self.per_ix {
            let refused: u64 = rej.values().sum();
            write!(f, "  {k:<26} ok {ok:>8}  refused {refused:>8}")?;
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

/// Instructions that do one thing once: sent again unchanged, each must be
/// refused or move nothing.
const REPLAYED: &[&str] = &[
    "settle_order",
    "execute_order",
    "cancel_order",
    "cancel_batch_order",
    "claim_rewards",
    "claim_withdraw_tokens",
    "liquidate",
    "sync_referral",
    "sync_deployer",
    "sync_backing",
    "collect_chain_fees",
    "accrue_points",
    "cancel_withdraw",
    "mark_backing",
];

/// Invariants a finding in fuzz/FINDINGS.md breaks. Counted, not failed,
/// until the program changes; each has an ignored regression test.
const KNOWN_FINDINGS: &[&str] = &[
    // Not a finding: the documented post-split aggregate, measured past ten
    // basis points (`split_drift`).
    "post_split_aggregate_drift",
];

pub struct Runner {
    pub env: Env,
    /// What the insurance fund has paid toward each market's losses, by
    /// market address.
    fund_paid: BTreeMap<Pubkey, u128>,
    /// What in-kind syncs have repaid the fund for each market, by market
    /// address (`BackingRepaidFund`).
    fund_repaid: BTreeMap<Pubkey, u128>,
    pub stats: Stats,
    trail: Vec<String>,
    step: usize,
    action: Option<Action>,
    /// The state the last landed transaction left, which is the state the
    /// next one starts from: nothing outside a transaction writes the
    /// accounts `check_tx` compares.
    last: Snap,
}

type Step = Result<(), Failure>;

impl Runner {
    pub fn new(env: Env) -> Runner {
        let last = Snap::take(&env);
        Runner { env, fund_paid: BTreeMap::new(), fund_repaid: BTreeMap::new(), stats: Stats::default(), trail: vec![], step: 0, action: None, last }
    }

    /// The transactions so far, one line each.
    pub fn trail(&self) -> String {
        self.trail.join("\n")
    }

    fn fail(&self, what: String) -> Failure {
        Failure { step: self.step, action: self.action.expect("action"), what, trail: self.trail.clone() }
    }

    /// Fails the case on any violation but a known finding, which is
    /// counted instead so a long campaign can go on past it. `FUZZ_STRICT`
    /// fails on those too.
    fn violations(&mut self, mut vs: Vec<Violation>) -> Step {
        if std::env::var_os("FUZZ_STRICT").is_none() {
            for v in vs.iter().filter(|v| KNOWN_FINDINGS.contains(&v.invariant)) {
                *self.stats.coverage.entry(v.invariant).or_default() += 1;
            }
            vs.retain(|v| !KNOWN_FINDINGS.contains(&v.invariant));
        }
        if vs.is_empty() {
            return Ok(());
        }
        let text = vs.iter().map(|v| format!("INVARIANT {}: {}", v.invariant, v.detail)).collect::<Vec<_>>().join("\n");
        Err(self.fail(text))
    }

    fn note(&mut self, label: &str, outcome: &TxOutcome) {
        let c = self.env.clock();
        self.trail.push(format!("[t={} s={}] {label}: {}", c.unix_timestamp, c.slot, match outcome {
            TxOutcome::Ok => "ok".to_string(),
            TxOutcome::Rejected { name, .. } => format!("refused {name}"),
            TxOutcome::Aborted { reason, .. } => format!("ABORTED {reason}"),
        }));
    }

    /// Sends one transaction, records how it went, and checks the state and
    /// transaction invariants if it landed. Some are sent twice.
    fn tx(&mut self, label: &'static str, ix: Ix) -> Result<TxOutcome, Failure> {
        let again = REPLAYED.contains(&label).then(|| (ix.0.clone(), ix.1.insecure_clone()));
        let outcome = self.env.send(ix);
        self.stats.record(label, &outcome);
        self.note(label, &outcome);
        match &outcome {
            TxOutcome::Aborted { reason, logs } => {
                let tail = logs.iter().rev().take(12).rev().cloned().collect::<Vec<_>>().join("\n    ");
                return Err(self.fail(format!("ABORT in {label}: {reason}\n    {tail}")));
            }
            TxOutcome::Ok => {
                let logs = std::mem::take(&mut self.env.last_logs);
                let ev = Events::parse(&logs);
                record_events(&mut self.stats, &ev);
                let after = Snap::take(&self.env);
                let mut vs = check_state(&after);
                vs.extend(check_tx(label, &self.last, &after, &ev));
                vs.extend(self.check_fund_ledger(&after, &ev));
                self.last = after;
                self.violations(vs)?;
                if let Some(ix) = again {
                    self.replay(label, ix)?;
                }
            }
            TxOutcome::Rejected { .. } => {}
        }
        Ok(outcome)
    }

    /// The fund ranks after the backers, in kind included: when backing
    /// tokens pay for a loss past the USDC (`sync_backing`), they may repay
    /// the LPs only what the LPs paid, not what the fund paid. The ledger of
    /// what the fund paid per market is kept here, from the state before the
    /// transaction (`self.last`) and after.
    ///
    /// The fund is repaid in tokens, or out of LP liquidity from tokens the
    /// LPs no longer bore a loss for (`BackingRepaidFund`), and a refund to
    /// the backers can hand that part back to them, which leaves it repaid
    /// by the LPs rather than the tokens. So the LPs' own part of what the
    /// book reimbursed is `reimbursed_usd - fund_reimbursed_usd`, and the
    /// fund's claim on the tokens is what it paid, less what syncs repaid it,
    /// plus what of that the tokens still stand behind
    /// (`fund_reimbursed_usd`).
    fn check_fund_ledger(&mut self, after: &Snap, ev: &Events) -> Vec<Violation> {
        let mut v = vec![];
        let b = &self.last;
        let drawn: u64 = ev.all::<InsuranceDrawn>().iter().map(|e| e.amount_usd).sum();
        if drawn > 0 {
            if let Some(m) = (0..b.markets.len()).find(|&m| after.markets[m].net_loss_usd > b.markets[m].net_loss_usd) {
                *self.fund_paid.entry(after.market_keys[m]).or_default() += drawn as u128;
            }
        }
        // A loser's gain in a sealed batch puts back what the fund paid that
        // batch's winners (`apply_batch_settlement_to_pool`).
        let put_back: u64 = ev.all::<InsuranceRepaid>().iter().map(|e| e.amount_usd).sum();
        if put_back > 0 {
            match (0..b.markets.len()).find(|&m| after.markets[m].net_loss_usd < b.markets[m].net_loss_usd) {
                Some(m) => {
                    let paid = self.fund_paid.entry(after.market_keys[m]).or_default();
                    ensure!(v, *paid >= put_back as u128, "in_kind_sync_repays_fund_losses_to_lps",
                        "market[{m}]: a batch put back {put_back} to the fund, which paid it only {paid}");
                    *paid = paid.saturating_sub(put_back as u128);
                }
                None => v.push(Violation {
                    invariant: "in_kind_sync_repays_fund_losses_to_lps",
                    detail: format!("the fund was put back {put_back} with no market's loss falling"),
                }),
            }
        }
        for e in ev.all::<BackingRepaidFund>() {
            let Some(m) = after.market_index(&e.market) else { continue };
            *self.fund_repaid.entry(after.market_keys[m]).or_default() += (e.in_kind_usd + e.usdc_usd) as u128;
        }
        let synced: Vec<Pubkey> = ev.all::<BackingPaidLps>().iter().map(|e| e.market)
            .chain(ev.all::<BackingRepaidFund>().iter().map(|e| e.market)).collect();
        for key in synced {
            let Some(m) = after.market_index(&key) else { continue };
            let Some(book) = &after.books[m] else { continue };
            let mk = &after.markets[m];
            let lp_borne = unwind::state::lp_borne_usd(mk.net_loss_usd, mk.backing_drawn_usd) as i128;
            let k = after.market_keys[m];
            let fund = self.fund_paid.get(&k).copied().unwrap_or(0) as i128
                - self.fund_repaid.get(&k).copied().unwrap_or(0) as i128
                + book.fund_reimbursed_usd as i128;
            let owed = (lp_borne - book.baseline_usd as i128 - fund).max(0);
            let lps = book.reimbursed_usd as i128 - book.fund_reimbursed_usd as i128;
            ensure!(v, lps <= owed + 1, "in_kind_sync_repays_fund_losses_to_lps",
                "market[{m}]: LPs reimbursed {lps} in kind for {} borne past the USDC, {fund} of it the fund's",
                lp_borne - book.baseline_usd as i128);
        }
        v
    }

    /// The same transaction again: refused, or a no-op on every balance.
    fn replay(&mut self, label: &'static str, ix: Ix) -> Step {
        let before = money(&self.last);
        let outcome = self.env.send(ix);
        self.note(label, &outcome);
        match outcome {
            TxOutcome::Rejected { .. } => self.stats.cover("check: replay refused"),
            TxOutcome::Aborted { reason, .. } => {
                return Err(self.fail(format!("ABORT replaying {label}: {reason}")));
            }
            TxOutcome::Ok => {
                self.env.last_logs.clear();
                let after = Snap::take(&self.env);
                self.stats.cover("check: replay landed as a no-op");
                let moved = money(&after) != before;
                let mut vs = check_state(&after);
                if moved {
                    vs.push(Violation { invariant: "replay_pays_nothing", detail: format!("{label} sent twice moved value") });
                }
                self.last = after;
                self.violations(vs)?;
            }
        }
        Ok(())
    }

    pub fn run(&mut self, actions: &[Action]) -> Step {
        // The fixture itself must satisfy every invariant.
        self.action = actions.first().copied();
        self.violations(check_state(&self.last))?;
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
            self.last = after;
            self.stats.steps += 1;
        }
        Ok(())
    }

    fn n_markets(&self) -> usize {
        self.env.markets.len()
    }

    fn source(&self, m: usize) -> Source {
        self.env.markets[m].source
    }

    /// Fresh prices: the relay reposts the feeds, the keeper pushes an
    /// observed mark and the crank folds one once they are 15 seconds old.
    fn repost(&mut self) -> Step {
        self.env.repost_feeds();
        let now = self.env.clock().unix_timestamp;
        for m in 0..self.n_markets() {
            let fx = self.env.markets[m].clone();
            if fx.source == Source::Pyth {
                continue;
            }
            let age = self
                .env
                .anchor::<unwind::state::Observation>(&fx.price_account)
                .map_or(i64::MAX, |o| now - o.last_update_ts);
            if age >= 15 {
                match fx.source {
                    Source::Keeper => {
                        self.tx("push_mark", self.env.ix_push_mark(m, fx.price))?;
                    }
                    _ => {
                        self.tx("observe", self.env.ix_observe(m))?;
                    }
                }
            }
        }
        Ok(())
    }

    /// Moves market `m`'s mark to `price` the way its source moves: the relay
    /// posts, the keeper pushes, a folded mark folds toward its pool.
    fn set_price(&mut self, m: usize, price: u64) -> Step {
        let price = price.max(1);
        self.env.post_price(m, price);
        match self.source(m) {
            Source::Pyth => {}
            Source::Keeper => {
                self.tx("push_mark", self.env.ix_push_mark(m, price))?;
            }
            Source::Folded => {
                self.tx("observe", self.env.ix_observe(m))?;
            }
        }
        Ok(())
    }

    /// One second and one slot on, with fresh prices: the cadence of a batch.
    fn tick(&mut self) -> Step {
        self.env.advance(1, 2);
        self.repost()
    }

    fn mark(&self, m: usize) -> u64 {
        self.env.oracle_price(m).max(1)
    }

    fn apply(&mut self, a: Action) -> Step {
        let nm = self.n_markets();
        match a {
            Action::Open { trader, market, long, maker, size_usd, lev_x, limit_bps, crank } => {
                let (t, m) = (trader as usize % N_TRADERS, market as usize % nm);
                let mk = self.env.market_state(m);
                let size = size_usd as u64 * USD;
                let fee = size * mk.open_fee_bps as u64 / 10_000;
                let collateral = size / lev_x.max(1) as u64 + fee + 1;
                let price = limit_price(self.mark(m), long, limit_bps);
                self.tx("submit_open", self.env.ix_submit_order(t, m, price, size, collateral, long, false, maker))?;
                if crank {
                    self.crank(m, false)?;
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
                let price = limit_price(self.mark(m), is_bid, limit_bps);
                self.tx("submit_close", self.env.ix_submit_order(t, m, price, size, 0, is_bid, true, maker))?;
                if crank {
                    self.crank(m, false)?;
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
            Action::Clear { market, permute } => {
                self.clear(market as usize % nm, permute)?;
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
            Action::Crank { market, reorder } => {
                self.crank(market as usize % nm, reorder)?;
            }
            Action::MovePrice { market, bps } => {
                let m = market as usize % nm;
                self.tick()?;
                let old = self.env.markets[m].price as i128;
                let new = (old * (BPS_I + bps as i128) / BPS_I).max(1) as u64;
                self.set_price(m, new)?;
            }
            Action::Cross { maker, taker, market, maker_long, size_usd, lev_x, crank, checks } => {
                let m = market as usize % nm;
                let (mt, tt) = (maker as usize % N_TRADERS, taker as usize % N_TRADERS);
                let tt = if tt == mt { (tt + 1) % N_TRADERS } else { tt };
                let mk = self.env.market_state(m);
                let mark = self.mark(m);
                let size = size_usd as u64 * USD;
                let collateral = size / lev_x.max(1) as u64 + size * mk.open_fee_bps as u64 / 10_000 + 1;
                // The maker quotes a little inside the mark, the taker reaches
                // past it, so the two cross at the maker's price or better.
                let mp = limit_price(mark, maker_long, -2);
                let tp = limit_price(mark, !maker_long, 60);
                self.tx("submit_open", self.env.ix_submit_order(mt, m, mp, size, collateral, maker_long, false, true))?;
                self.tx("submit_open", self.env.ix_submit_order(tt, m, tp, size, collateral, !maker_long, false, false))?;
                if crank && checks {
                    self.clear(m, true)?;
                    self.settle_reordered(m)?;
                } else if crank {
                    self.crank(m, false)?;
                }
            }
            Action::Shock { nth, market, bps, liquidate, favor } => {
                let m = market as usize % nm;
                let Some((t, pos)) = self.nth_open(m, nth) else { return Ok(()) };
                self.tick()?;
                let old = self.env.markets[m].price as i128;
                let b = bps as i128;
                let down = pos.is_long != favor;
                let new = if down { old * (BPS_I - b.min(9_900)) / BPS_I } else { old * (BPS_I + b) / BPS_I };
                self.set_price(m, new.max(1) as u64)?;
                self.catch_up(m)?;
                if liquidate {
                    let owner = self.env.traders[t].pubkey();
                    self.tx("liquidate", self.env.ix_liquidate(m, owner))?;
                }
            }
            Action::Warp { secs, repost } => {
                self.env.advance(secs as i64, secs as u64 * 5 / 2 + 1);
                if repost {
                    self.repost()?;
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
                    self.env.advance(60, WITHDRAW_COOLDOWN_SLOTS);
                    self.repost()?;
                }
                let amount = ((req.shares as u128 * pct as u128 / 100) as u64).max(1);
                self.lp_claim(l, amount)?;
            }
            Action::LpCancel { lp } => {
                let l = lp as usize % N_LPS;
                let owner = self.env.lps[l].pubkey();
                if self.env.account(&self.env.withdraw_request(&owner)).is_none() {
                    return Ok(());
                }
                self.tx("cancel_withdraw", self.env.ix_cancel_withdraw(l))?;
            }
            Action::LpDrain { lp } => {
                let l = lp as usize % N_LPS;
                let owner = self.env.lps[l].pubkey();
                let held = self.env.lp_of(&owner);
                if held > 0 {
                    self.tx("request_withdraw", self.env.ix_request_withdraw(l, held))?;
                }
                let Some(req) = self.env.anchor::<unwind::state::WithdrawRequest>(&self.env.withdraw_request(&owner)) else {
                    return Ok(());
                };
                self.env.advance(60, WITHDRAW_COOLDOWN_SLOTS);
                self.repost()?;
                // As much as the pool lets go: the largest claim that lands,
                // by bisection over the escrowed shares.
                if let TxOutcome::Ok = self.lp_claim(l, req.shares)? {
                    self.stats.cover("action: LP drained");
                    return Ok(());
                }
                let (mut lo, mut hi) = (0u64, req.shares);
                for _ in 0..14 {
                    let mid = lo + (hi - lo) / 2;
                    if mid == lo {
                        break;
                    }
                    let mut probe = self.env.clone();
                    probe.send(probe.ix_checkpoint_aum(true, &probe.oi_pairs()));
                    match probe.send(probe.ix_claim_withdraw(l, mid)) {
                        TxOutcome::Ok => lo = mid,
                        _ => hi = mid,
                    }
                }
                if lo > 0 {
                    if let TxOutcome::Ok = self.lp_claim(l, lo)? {
                        self.stats.cover("action: LP drained");
                    }
                }
            }
            Action::Back { backer, market, usd, asset } => {
                let (b, m) = (backer as usize % N_BACKERS, market as usize % nm);
                let asset = asset as usize % (self.env.custodies.len() + 1);
                let amount = match asset {
                    0 => usd as u64 * USD,
                    a => {
                        let c = &self.env.custodies[a - 1];
                        (usd as u128 * 10u128.pow(c.decimals as u32) * USD as u128 / c.price.max(1) as u128) as u64
                    }
                };
                if let TxOutcome::Ok = self.tx("back_market", self.env.ix_back_market(b, m, asset, amount))? {
                    if asset > 0 {
                        self.stats.cover("action: backed in kind");
                    }
                }
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
            Action::SyncBacking { market } => {
                let m = market as usize % nm;
                if self.env.book_state(m).is_none() {
                    return Ok(());
                }
                self.tx("sync_backing", self.env.ix_sync_backing(m))?;
            }
            Action::MarkBacking { backer, market } => {
                let (b, m) = (backer as usize % N_BACKERS, market as usize % nm);
                if self.env.backing_shares(b, m) == 0 || self.env.book_state(m).is_none() {
                    return Ok(());
                }
                self.tx("mark_backing", self.env.ix_mark_backing(b, m))?;
            }
            Action::CustodyPrice { bps } => {
                let Some(i) = self.env.custodies.iter().position(|c| !c.stable) else { return Ok(()) };
                let old = self.env.custodies[i].price as i128;
                let new = (old * (BPS_I + bps as i128) / BPS_I).max(1) as u64;
                self.env.advance(1, 2);
                self.env.post_custody_price(i, new);
                self.repost()?;
            }
            Action::ClaimTokens { lp, custody } => {
                if self.env.custodies.is_empty() {
                    return Ok(());
                }
                let (l, i) = (lp as usize % N_LPS, custody as usize % self.env.custodies.len());
                let owner = self.env.lps[l].pubkey();
                if self.env.account(&self.env.token_claim_address(&owner)).is_none() {
                    return Ok(());
                }
                self.tx("claim_withdraw_tokens", self.env.ix_claim_withdraw_tokens(l, i))?;
            }

            Action::PlaceTrigger { trader, market, slot, open, long, size_usd, lev_x, trigger_bps, above, expiry } => {
                let m = market as usize % nm;
                // A close trigger is for somebody holding a position.
                let t = match (open, self.nth_open(m, trader)) {
                    (false, Some((t, _))) => t,
                    _ => trader as usize % N_TRADERS,
                };
                let mk = self.env.market_state(m);
                let mark = self.mark(m) as i128;
                let trigger = (mark * (BPS_I + trigger_bps as i128) / BPS_I).max(1) as u64;
                let size = size_usd as u64 * USD;
                let (kind, size, collateral) = if open {
                    (1u8, size, size / lev_x.max(1) as u64 + size * mk.open_fee_bps as u64 / 10_000 + 1)
                } else if size_usd % 3 == 0 {
                    (0u8, 0, 0)
                } else {
                    (0u8, size, 0)
                };
                let expiry_ts = if expiry == 0 { 0 } else { self.env.clock().unix_timestamp + expiry as i64 };
                let params = unwind::instructions::OrderParams {
                    slot,
                    kind,
                    is_long: long,
                    size_usd: size,
                    collateral_usd: collateral,
                    trigger_price: trigger,
                    trigger_above: above,
                    expiry_ts,
                };
                // Known before it lands, so the state checked after it
                // already counts its escrow.
                let fresh = self.env.trigger_keys.insert((t, m, slot));
                if let TxOutcome::Rejected { .. } = self.tx("place_order", self.env.ix_place_order(t, m, params))? {
                    if fresh {
                        self.env.trigger_keys.remove(&(t, m, slot));
                    }
                }
            }
            Action::ExecTrigger { nth, market, through, crank } => {
                let m = market as usize % nm;
                let here: Vec<(usize, usize, u8)> =
                    self.last.orders.iter().map(|(k, _)| *k).filter(|k| k.1 == m).collect();
                if here.is_empty() {
                    return Ok(());
                }
                let (t, _, slot) = here[nth as usize % here.len()];
                let Some(o) = self.env.order_state(t, m, slot) else { return Ok(()) };
                if through {
                    // Through the trigger, a little past it, in the terms the
                    // market quotes now.
                    let mk = self.env.market_state(m);
                    let at = o.trigger_at(mk.price_factor).unwrap_or(o.trigger_price) as i128;
                    let past = if o.trigger_above { at * 10_020 / BPS_I + 1 } else { at * 9_980 / BPS_I };
                    self.tick()?;
                    self.set_price(m, past.max(1) as u64)?;
                }
                let outcome = self.tx("execute_order", self.env.ix_execute_order(t, m, slot))?;
                if self.env.order_state(t, m, slot).is_none() {
                    self.env.trigger_keys.remove(&(t, m, slot));
                    self.last = Snap::take(&self.env);
                }
                if crank && matches!(outcome, TxOutcome::Ok) {
                    self.crank(m, false)?;
                }
            }
            Action::CancelTrigger { nth } => {
                let keys: Vec<(usize, usize, u8)> = self.last.orders.iter().map(|(k, _)| *k).collect();
                if keys.is_empty() {
                    return Ok(());
                }
                let (t, m, slot) = keys[nth as usize % keys.len()];
                if let TxOutcome::Ok = self.tx("cancel_order", self.env.ix_cancel_order(t, m, slot))? {
                    self.env.trigger_keys.remove(&(t, m, slot));
                    self.last = Snap::take(&self.env);
                }
            }

            Action::Split { market, ratio } => {
                let m = market as usize % nm;
                let (num, den) = split_ratio(ratio);
                self.split(m, num, den)?;
            }
            Action::PauseMarket { market, paused } => {
                let m = market as usize % nm;
                self.tx("set_market_paused", self.env.ix_set_market_paused(m, paused))?;
            }
            Action::PoolPauseBlip { trader, market } => {
                let (t, m) = (trader as usize % N_TRADERS, market as usize % nm);
                self.tx("set_pool_paused", self.env.ix_set_pool_paused(true))?;
                let price = limit_price(self.mark(m), true, 50);
                let outcome = self.tx("submit_open", self.env.ix_submit_order(t, m, price, 100 * USD, 50 * USD, true, false, false))?;
                if let TxOutcome::Ok = outcome {
                    return Err(self.fail("INVARIANT paused_pool_takes_no_orders: an open landed in a paused pool".into()));
                }
                self.tx("set_pool_paused", self.env.ix_set_pool_paused(false))?;
            }
            Action::SetBudget { market, pct } => {
                let m = market as usize % nm;
                let mk = self.env.market_state(m);
                let new = (mk.loss_budget_usd as u128 * pct as u128 / 100) as u64;
                self.tx("set_market_budget", self.env.ix_set_market_budget(m, new))?;
            }
            Action::SetSession { market, session } => {
                let m = market as usize % nm;
                self.tx("set_session", self.env.ix_set_session(m, session))?;
            }
            Action::UpdateParams { market, field, value } => {
                let m = market as usize % nm;
                let params = tweak_params(&self.env.market_state(m), field, value);
                self.tx("update_market_params", self.env.ix_update_market(m, params))?;
            }
            Action::CollectFees { protocol, pct } => {
                if protocol {
                    let have = self.env.pool_state().protocol_fees_usd;
                    let amount = (have as u128 * pct as u128 / 100) as u64;
                    self.tx("collect_protocol_fees", self.env.ix_collect_protocol_fees(amount))?;
                } else {
                    self.tx("collect_chain_fees", self.env.ix_collect_chain_fees())?;
                }
            }
            Action::FundInsurance { usd } => {
                self.tx("fund_insurance", self.env.ix_fund_insurance(1, usd as u64 * USD))?;
            }
            Action::Adl { nth, market } => {
                let m = market as usize % nm;
                let Some((t, _)) = self.nth_open(m, nth) else { return Ok(()) };
                let owner = self.env.traders[t].pubkey();
                self.tx("auto_deleverage", self.env.ix_auto_deleverage(m, owner))?;
            }
            Action::AuthorityRoundTrip { via } => {
                let k = self.env.traders[via as usize % N_TRADERS].insecure_clone();
                let auth = self.env.authority.insecure_clone();
                if let TxOutcome::Ok = self.tx("nominate_authority", self.env.ix_nominate_authority(&auth, k.pubkey()))? {
                    // Nobody but the nominee may take it.
                    let wrong = self.env.traders[(via as usize + 1) % N_TRADERS].insecure_clone();
                    if let TxOutcome::Ok = self.tx("accept_authority", self.env.ix_accept_authority(&wrong))? {
                        return Err(self.fail("INVARIANT only_the_nominee_accepts: another wallet took the pool".into()));
                    }
                    self.tx("accept_authority", self.env.ix_accept_authority(&k))?;
                    // While the trader holds it, the old key is nobody.
                    if let TxOutcome::Ok = self.tx("set_pool_paused", self.env.ix_set_pool_paused(false))? {
                        return Err(self.fail("INVARIANT authority_moves: the old authority still acts".into()));
                    }
                    self.tx("nominate_authority", self.env.ix_nominate_authority(&k, auth.pubkey()))?;
                    self.tx("accept_authority", self.env.ix_accept_authority(&auth))?;
                    let p = self.env.pool_state();
                    if p.authority != auth.pubkey() {
                        return Err(self.fail("INVARIANT authority_round_trip: the pool did not come back".into()));
                    }
                }
            }
            Action::SetPoints { enabled } => {
                self.tx("set_pool_points", self.env.ix_set_pool_points(enabled))?;
            }
            Action::KeeperBlip { market } => {
                let Some(m) = (0..nm).map(|i| (i + market as usize) % nm).find(|&i| self.source(i) == Source::Keeper) else {
                    return Ok(());
                };
                self.tx("set_mark_keeper", self.env.ix_set_mark_keeper(Pubkey::default()))?;
                let p = self.env.markets[m].price;
                if let TxOutcome::Ok = self.tx("push_mark", self.env.ix_push_mark(m, p))? {
                    return Err(self.fail("INVARIANT no_keeper_no_push: a push landed with no keeper".into()));
                }
                let auth = self.env.authority.pubkey();
                self.tx("set_mark_keeper", self.env.ix_set_mark_keeper(auth))?;
            }
            Action::Resize { which } => {
                match which % 3 {
                    0 => {
                        let m = which as usize % nm;
                        self.tx("resize_market", self.env.ix_resize_market(m))?;
                    }
                    1 => {
                        self.tx("resize_pool", self.env.ix_resize_pool())?;
                    }
                    _ => {
                        let owner = self.env.authority.pubkey();
                        self.tx("resize_trader", self.env.ix_resize_trader(&owner))?;
                    }
                }
            }

            Action::Observe { market, times } => {
                let Some(m) = self.observed(market) else { return Ok(()) };
                // A mark still seasoning is read until it is: the crank a
                // lister runs for a new observed market.
                let unseasoned = self
                    .env
                    .anchor::<unwind::state::Observation>(&self.env.markets[m].price_account)
                    .is_some_and(|o| !o.is_seasoned());
                let times = if unseasoned { 32 } else { times };
                for _ in 0..times {
                    // An unseasoned mark is read 32 seconds apart, so thirty
                    // readings span the fifteen minutes seasoning needs.
                    let seasoned = self
                        .env
                        .anchor::<unwind::state::Observation>(&self.env.markets[m].price_account)
                        .is_some_and(|o| o.is_seasoned());
                    if seasoned {
                        self.env.advance(1, 2);
                        self.env.repost_feeds();
                    } else {
                        self.env.advance(32, 80);
                        self.repost()?;
                    }
                    if let TxOutcome::Ok = self.tx("observe", self.env.ix_observe(m))? {
                        let now_seasoned = self
                            .env
                            .anchor::<unwind::state::Observation>(&self.env.markets[m].price_account)
                            .is_some_and(|o| o.is_seasoned());
                        if now_seasoned && !seasoned {
                            self.stats.cover("action: a new observed mark seasoned");
                        }
                    }
                }
            }
            Action::ThinPool { market, pct } => {
                let Some(m) = self.observed(market) else { return Ok(()) };
                let fx = self.env.markets[m].clone();
                // Quadratic, so small `pct` reaches pools thin enough to
                // halt the market on confidence; 100 restores the depth.
                let liq = DEEP_CLMM_LIQUIDITY * (pct as u128).pow(2) / 10_000;
                let spot = if fx.source == Source::Folded { fx.price } else { self.mark(m) };
                self.env.write_clmm(fx.amm, spot, liq.max(1));
                // Budget depth closes a tenth of the gap per interval: read
                // until it is under the budget, or for an hour at most.
                for _ in 0..120 {
                    self.env.advance(unwind::constants::DEPTH_RISE_MIN_INTERVAL_SEC, 50);
                    self.repost()?;
                    self.tx("observe", self.env.ix_observe(m))?;
                    let o = self.env.anchor::<unwind::state::Observation>(&fx.price_account).expect("observation");
                    let budget = self.env.market_state(m).loss_budget_usd;
                    // Done once under the budget, or when the pool itself is
                    // not, so no number of readings will get there.
                    if o.budget_depth_usd < budget || o.depth_usd >= budget {
                        break;
                    }
                }
                self.tx("derive_market_budget", self.env.ix_derive_budget(m))?;
            }
            Action::DeriveBudget { market } => {
                let Some(m) = self.observed(market) else { return Ok(()) };
                self.tx("derive_market_budget", self.env.ix_derive_budget(m))?;
            }

            Action::ListGeneration { feed, lister } => {
                if nm >= 8 {
                    return Ok(());
                }
                let firsts: Vec<usize> = (0..nm).filter(|&i| self.env.markets[i].generation == 1).collect();
                let base = firsts[feed as usize % firsts.len()];
                let fx = self.env.markets[base].clone();
                let next = self.env.markets.iter().filter(|o| o.feed_id == fx.feed_id).map(|o| o.generation).max().unwrap() + 1;
                let mut spec = fx.spec;
                spec.price = fx.price;
                // An observed market's observation is its lister's to
                // create, which the harness signs as the authority.
                let who = (lister > 0 && fx.source == Source::Pyth).then(|| (lister as usize - 1) % ACTIVE_TRADERS);
                let i = match self.env.try_list(spec, next, who) {
                    Ok(i) => i,
                    Err(e) => {
                        self.stats.record("add_market", &e);
                        return Ok(());
                    }
                };
                self.stats.record("add_market", &TxOutcome::Ok);
                self.last = Snap::take(&self.env);
                self.violations(check_state(&self.last))?;
                self.tx("create_batch", self.env.ix_create_batch(i))?;
                match fx.source {
                    Source::Pyth => {}
                    // A keeper-priced mark trades from its first push; a
                    // folded one only once seasoned, thirty readings over
                    // fifteen minutes (`Observe` spaces them out).
                    Source::Keeper => {
                        self.tx("create_observation", self.env.ix_create_observation(i))?;
                        self.tx("push_mark", self.env.ix_push_mark(i, fx.price))?;
                    }
                    Source::Folded => {
                        self.tx("create_observation", self.env.ix_create_observation(i))?;
                    }
                }
                self.tx("back_market", self.env.ix_back_market(0, i, 0, 20_000 * USD))?;
            }
            Action::FillBatch { market, maker } => {
                let m = market as usize % nm;
                self.fill_batch(m, maker)?;
            }

            Action::CreateTrader { who } => {
                let k = self.env.owner_key(who as usize);
                self.tx("create_trader", self.env.ix_create_trader(&k))?;
            }
            Action::ClaimCode { who, code } => {
                let k = self.env.owner_key(who as usize);
                // `code{N_CODES}` is out of the alphabet: upper case.
                let bytes = if code >= N_CODES {
                    let mut c = [0u8; REFERRAL_CODE_LEN];
                    c[..3].copy_from_slice(b"BAD");
                    c
                } else {
                    code_bytes(code)
                };
                self.tx("claim_referral_code", self.env.ix_claim_referral_code(&k, bytes))?;
            }
            Action::SetReferrer { trader, code } => {
                let k = self.env.traders[trader as usize % N_TRADERS].insecure_clone();
                let c = code_bytes(code % N_CODES);
                let holder = self
                    .env
                    .anchor::<unwind::state::ReferralCode>(&pda(&[REFERRAL_CODE_SEED, c.as_ref()]))
                    .map_or(Pubkey::default(), |r| r.owner);
                if holder == Pubkey::default() {
                    return Ok(());
                }
                self.tx("set_referrer", self.env.ix_set_referrer(&k, c, holder))?;
            }
            Action::SyncReferral { trader } => {
                let owner = self.env.traders[trader as usize % N_TRADERS].pubkey();
                let Some(rec) = self.env.trader_state(&owner) else { return Ok(()) };
                if !rec.has_referrer() {
                    return Ok(());
                }
                self.tx("sync_referral", self.env.ix_sync_referral(&owner, &rec.referrer))?;
            }
            Action::SyncDeployer { market } => {
                let m = market as usize % nm;
                let deployer = self.env.market_state(m).deployer;
                if self.env.trader_state(&deployer).is_none() {
                    let k = if deployer == self.env.authority.pubkey() {
                        self.env.authority.insecure_clone()
                    } else {
                        match self.env.traders.iter().find(|k| k.pubkey() == deployer) {
                            Some(k) => k.insecure_clone(),
                            None => return Ok(()),
                        }
                    };
                    self.tx("create_trader", self.env.ix_create_trader(&k))?;
                }
                self.tx("sync_deployer", self.env.ix_sync_deployer(m, &deployer))?;
            }
            Action::ClaimRewards { who } => {
                // Mostly a wallet with something to claim.
                let owed: Vec<usize> = (0..self.last.records.len())
                    .filter(|&i| self.last.records[i].as_ref().is_some_and(|t| t.rewards_usd > 0))
                    .collect();
                let i = if !owed.is_empty() && who % 4 != 0 { owed[who as usize % owed.len()] } else { who as usize };
                let k = self.env.owner_key(i);
                if self.env.trader_state(&k.pubkey()).is_none() {
                    return Ok(());
                }
                self.tx("claim_rewards", self.env.ix_claim_rewards(&k))?;
            }
            Action::AccruePoints { who, show_lp } => {
                let with: Vec<usize> = (0..self.last.records.len()).filter(|&i| self.last.records[i].is_some()).collect();
                if with.is_empty() {
                    return Ok(());
                }
                let k = self.env.owner_key(with[who as usize % with.len()]);
                let has_lp_account = self.env.account(&token_account_address(&k.pubkey(), &self.env.lp_mint)).is_some();
                self.tx("accrue_points", self.env.ix_accrue_points(&k, show_lp && has_lp_account))?;
            }
        }
        Ok(())
    }

    /// The first observed market at or after `market`, if any.
    fn observed(&self, market: u8) -> Option<usize> {
        let nm = self.n_markets();
        (0..nm).map(|i| (i + market as usize) % nm).find(|&i| self.source(i) != Source::Pyth)
    }

    /// A claim, then the tokens it is owed in kind pulled from each custody
    /// the way a client follows one up.
    fn lp_claim(&mut self, l: usize, amount: u64) -> Result<TxOutcome, Failure> {
        self.prepare_lp()?;
        let before = Snap::take(&self.env);
        let outcome = self.tx("claim_withdraw", self.env.ix_claim_withdraw(l, amount))?;
        if let TxOutcome::Ok = outcome {
            let after = Snap::take(&self.env);
            self.violations(check_no_dilution("claim", &before, &after))?;
            let owner = self.env.lps[l].pubkey();
            if let Some(tc) = self.env.anchor::<LpTokenClaim>(&self.env.token_claim_address(&owner)) {
                for i in 0..self.env.custodies.len() {
                    if tc.owed[self.last.custodies[i].index as usize] > 0 {
                        self.tx("claim_withdraw_tokens", self.env.ix_claim_withdraw_tokens(l, i))?;
                    }
                }
            }
        }
        Ok(outcome)
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

    /// Steps market `m`'s risk price until it reaches the mark.
    fn catch_up(&mut self, m: usize) -> Step {
        for _ in 0..80 {
            if self.env.market_state(m).risk_price == self.env.oracle_price(m) {
                break;
            }
            self.env.advance(0, 3);
            if let TxOutcome::Rejected { .. } = self.tx("step_risk_price", self.env.ix_step_risk_price(m))? {
                break;
            }
        }
        Ok(())
    }

    fn crank(&mut self, m: usize, reorder: bool) -> Step {
        self.clear(m, false)?;
        if reorder {
            self.settle_reordered(m)
        } else {
            self.settle_all(m, 0)
        }
    }

    fn clear(&mut self, m: usize, permute: bool) -> Step {
        if !self.env.batch_state(m).is_open() {
            return Ok(());
        }
        self.tick()?;
        if permute {
            self.clear_permuted(m)?;
        }
        self.tx("clear_batch", self.env.ix_clear_batch(m))?;
        Ok(())
    }

    /// Clears a copy of the world with the batch's resting orders reversed
    /// in their slots, then the real one, and compares the two clearings.
    ///
    /// The auction is meant to be one price per flow from the book as a set
    /// (docs/auction.md), so the prices and the matched totals must not move.
    /// How a flow's fill is shared among orders at the clearing price may be
    /// first come by design; where it is, that shows up here as a coverage
    /// count, not a failure.
    fn clear_permuted(&mut self, m: usize) -> Step {
        let b = self.env.batch_state(m);
        let slots: Vec<usize> = (0..b.orders.len()).filter(|&i| b.orders[i].is_active()).collect();
        if slots.len() < 2 {
            return Ok(());
        }
        let mut alt = self.env.clone();
        let mut pb = b;
        for (k, &i) in slots.iter().enumerate() {
            pb.orders[i] = b.orders[slots[slots.len() - 1 - k]];
        }
        alt.write_batch(m, &pb);
        let ix = alt.ix_clear_batch(m);
        let alt_out = alt.send(ix);
        let ix = self.env.ix_clear_batch(m);
        let mut real = self.env.clone();
        let real_out = real.send(ix);
        match (&alt_out, &real_out) {
            (TxOutcome::Ok, TxOutcome::Ok) => {}
            (TxOutcome::Rejected { .. }, TxOutcome::Rejected { .. }) => return Ok(()),
            _ => {
                return Err(self.fail(format!(
                    "INVARIANT clearing_independent_of_insertion_order: reversed {alt_out:?}, as inserted {real_out:?}"
                )))
            }
        }
        self.stats.cover("check: clearing compared across insertion orders");
        let (x, y) = (alt.batch_state(m), real.batch_state(m));
        let totals = |b: &Batch| (b.buy_price, b.buy_matched_usd, b.sell_price, b.sell_matched_usd);
        if totals(&x) != totals(&y) {
            return Err(self.fail(format!(
                "INVARIANT clearing_independent_of_insertion_order: reversed {:?} vs as inserted {:?} \
                 (buy price, buy matched, sell price, sell matched)",
                totals(&x),
                totals(&y)
            )));
        }
        let fills = |b: &Batch| {
            let mut f: Vec<_> = b
                .orders
                .iter()
                .filter(|o| o.is_active())
                .map(|o| (o.owner, o.price, o.size_usd, o.is_bid, o.reduce_only, o.is_maker, o.filled_usd))
                .collect();
            f.sort();
            f
        };
        if fills(&x) != fills(&y) {
            self.stats.cover("check: per-order fills shared by arrival (by design)");
        }
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
            // FINDING 3: a split rounded an entry to zero, and the position's
            // PnL can no longer be read.
            let mk = self.env.market_state(m);
            let zero_entry = mk.split_epoch > 0
                && self.last.positions[m]
                    .iter()
                    .flatten()
                    .any(|q| q.is_open() && mk.adjust_entry_price(q.entry_price, q.entry_price_factor) == Ok(0));
            if name == "InvalidOraclePrice" && zero_entry {
                let detail = format!("settle_order(market {m}, index {index}) refused: an entry rebased to zero");
                return self.violations(vec![Violation { invariant: "split_rounds_an_entry_to_zero", detail }]);
            }
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

    /// Settles a copy of the world in reverse, then the real one in order,
    /// and compares where every trader and the pool end up.
    ///
    /// Settlement is permissionless and anyone picks the order, so it must
    /// not decide who gets what, except where the design says it does: when
    /// a market's winners can reach its remaining budget, a loser settling
    /// first restores budget a winner then draws on (docs/loss-budget.md).
    /// Those cases are counted, not failed.
    fn settle_reordered(&mut self, m: usize) -> Step {
        let active = self.sealed_active(m);
        if active.len() < 2 {
            return self.settle_all(m, 0);
        }
        let binds = budget_can_bind(&self.last);
        let before = self.last.clone();
        let mut alt = self.env.clone();
        let mut haircut = false;
        for &(i, owner) in active.iter().rev() {
            let ix = alt.ix_settle_order(m, i, owner);
            match alt.send(ix) {
                TxOutcome::Ok => {
                    haircut |= Events::parse(&alt.last_logs).has::<ProfitHaircut>();
                }
                // A refusal is the real settlement's to report, in order.
                _ => return self.settle_all(m, 0),
            }
        }
        let start = self.stats.coverage.get("event: profit haircut").copied().unwrap_or(0);
        let batch = self.env.batch_state(m);
        self.settle_all(m, 0)?;
        haircut |= self.stats.coverage.get("event: profit haircut").copied().unwrap_or(0) > start;
        let (x, y) = (Snap::take(&alt), Snap::take(&self.env));
        let (diffs, tol) = settlement_diffs(&before, &x, &y, &active, &batch, m);
        let (lx, _, _) = value_split(&x);
        let (ly, _, _) = value_split(&y);
        // Value moved between the backers and everyone else past what the
        // fills' rounding can move (a blended entry rounds by a unit, which
        // lands on the LPs or the backers through the book they hold).
        let moved = (backers_value(&x) - backers_value(&y)).abs() > tol;
        // With LP liquidity under what the batch's fees could cut from it,
        // a cut is clamped to the liquidity there is when it is taken
        // (`take_fee_cuts`, the backers' close fee too), and the order
        // decides when that is (fuzz/FINDINGS.md, documented behavior).
        let mk = &before.markets[m];
        let fee_room: u128 = active
            .iter()
            .map(|&(i, _)| {
                let bps = mk.open_fee_bps.max(mk.close_fee_bps) as u128;
                batch.orders[i as usize].filled_usd as u128 * bps / BPS + 1
            })
            .sum();
        let cuts = |s: &Snap| (s.pool.protocol_fees_usd, s.pool.chain_fees_usd, s.pool.insurance_usd, s.pool.rewards_usd);
        let clamped = (before.pool.liquidity_usd as u128) < fee_room && cuts(&x) != cuts(&y);
        if diffs.is_empty() && moved && clamped {
            self.stats.cover("check: settlement order met fee cuts clamped to drained LP liquidity (by design)");
        } else if diffs.is_empty() && moved && self_netting(&active, &batch) {
            // A wallet closing and opening in one batch: the order decides
            // how much of its PnL is realized (to the LPs, past what backing
            // was drawn) and how much stays a winner owed from backing first.
            self.stats.cover("check: settlement order split a self-netting wallet's PnL differently (by design)");
        } else if diffs.is_empty() && moved {
            // FINDING 2: a loser settled before a winner sends its loss to the
            // LPs and the winner's profit to the backers; the other way round
            // the loss repays the backing the winner drew.
            let lines = |s: &Snap| {
                let p = &s.pool;
                format!("liquidity {} backing {} fund {} protocol {} chain {} rewards {}", p.liquidity_usd, p.backing_usd,
                    p.insurance_usd, p.protocol_fees_usd, p.chain_fees_usd, p.rewards_usd)
            };
            let orders: Vec<_> = active.iter().map(|&(i, _)| {
                let o = &batch.orders[i as usize];
                (i, o.reduces(), o.bid(), o.filled_usd)
            }).collect();
            let detail = format!("backers hold {} settled in reverse vs {} in order, LPs {lx} vs {ly}\n    \
                reverse: {}\n    in order: {}\n    orders (index, close, bid, filled): {orders:?}",
                backers_value(&x), backers_value(&y), lines(&x), lines(&y));
            self.violations(vec![Violation { invariant: "settlement_order_moves_value_between_backers_and_lps", detail }])?;
        } else if diffs.is_empty() {
            self.stats.cover("check: settlement order compared, identical");
        } else if binds || haircut {
            self.stats.cover("check: settlement order mattered under a binding budget (by design)");
        } else {
            return Err(self.fail(format!(
                "INVARIANT settlement_independent_of_order: reversed vs in order differ: {}",
                diffs.join("; ")
            )));
        }
        Ok(())
    }

    /// Four small orders from every wallet until the batch refuses one,
    /// then a crank: the 64-order batch, the per-wallet cap and the full
    /// batch, and settling all of it.
    fn fill_batch(&mut self, m: usize, maker: bool) -> Step {
        if !self.env.batch_state(m).is_open() {
            self.settle_all(m, 0)?;
        }
        let mark = self.mark(m);
        let mk = self.env.market_state(m);
        let mut full = false;
        for t in 0..N_TRADERS {
            let pos = self.env.position_state(m, &self.env.traders[t].pubkey());
            let bid = match pos.filter(|p| p.is_open()) {
                Some(p) => p.is_long,
                None => t % 2 == 0,
            };
            for k in 0..=MAX_ORDERS_PER_OWNER as u64 {
                let size = mk.min_position_usd.max(10 * USD) + k * USD;
                let collateral = size / 2 + size * mk.open_fee_bps as u64 / 10_000 + 1;
                // Makers rest 2% behind the mark; takers reach 30 bps through.
                let price = if maker { limit_price(mark, bid, -200) } else { limit_price(mark, bid, 30) };
                let out = self.tx("submit_open", self.env.ix_submit_order(t, m, price, size, collateral, bid, false, maker))?;
                if let TxOutcome::Rejected { name } = &out {
                    if name == "TooManyOrders" {
                        self.stats.cover("check: fifth order from one wallet refused");
                        break;
                    }
                    if name == "BatchFull" {
                        self.stats.cover("check: 65th order refused, batch full");
                        full = true;
                        break;
                    }
                }
            }
            if full {
                break;
            }
        }
        let active = self.env.batch_state(m).orders.iter().filter(|o| o.is_active()).count();
        if active == unwind::auction::MAX_BATCH_ORDERS {
            self.stats.cover("state: batch holds 64 orders");
        }
        self.crank(m, false)
    }

    /// Pauses every market on `m`'s feed, applies the split to each, moves
    /// the mark with it, checks nothing changed in value, and unpauses.
    fn split(&mut self, m: usize, num: u64, den: u64) -> Step {
        let fx = self.env.markets[m].clone();
        let family: Vec<usize> =
            (0..self.n_markets()).filter(|&i| self.env.markets[i].price_account == fx.price_account).collect();
        for &i in &family {
            if !self.env.batch_state(i).is_open() {
                self.settle_all(i, 0)?;
            }
            self.tx("set_market_paused", self.env.ix_set_market_paused(i, true))?;
        }
        let before = Snap::take(&self.env);
        let mut applied = vec![];
        for &i in &family {
            if let TxOutcome::Ok = self.tx("apply_corporate_action", self.env.ix_corporate_action(i, num, den))? {
                applied.push(i);
            }
        }
        if applied.len() == family.len() {
            let new = (fx.price as u128 * num as u128 / den as u128).max(1) as u64;
            match fx.source {
                Source::Pyth => self.env.post_price(m, new),
                Source::Keeper => {
                    self.env.post_price(m, new);
                    self.tx("push_mark", self.env.ix_push_mark(m, new))?;
                }
                Source::Folded => {
                    // The observation moved with the split; the pool did too.
                    self.env.post_price(m, new);
                }
            }
            let after = Snap::take(&self.env);
            for &i in &applied {
                self.violations(check_split(&before, &after, i, num, den))?;
            }
        }
        for &i in &family {
            self.tx("set_market_paused", self.env.ix_set_market_paused(i, false))?;
        }
        Ok(())
    }
}

/// Whether any market's winners could reach its remaining budget: where
/// they can, what a winner is paid depends on settlement order by design.
///
/// Winners are counted at the larger of the program's bound and what the
/// positions are owed with funding brought up to now: funding received is
/// profit the budget pays too.
fn budget_can_bind(s: &Snap) -> bool {
    s.markets.iter().enumerate().any(|(m, mk)| {
        let price = s.oracle[m];
        let bound = mk.side_winners_usd(true, price).unwrap_or(u64::MAX) as u128
            + mk.side_winners_usd(false, price).unwrap_or(u64::MAX) as u128;
        let valued = unwind::aum::accrued_to(mk, &s.pool, s.now).expect("accrue");
        let owed: u128 = s
            .open_positions(m)
            .map(|q| {
                let (pnl, funding, _) = position_terms(&valued, q, price);
                (pnl as i128 - funding as i128).max(0) as u128
            })
            .sum();
        mk.has_open_interest() && bound.max(owed) >= mk.remaining_budget_usd() as u128
    })
}

/// Where two worlds settled in different orders disagree in value.
///
/// Compared at the oracle, not line by line. A wallet with an open and a
/// close in the same batch books them differently by order: the close first
/// realizes the old position and the open starts a new one, the open first
/// blends into the old one and the close realizes part of the blend. Same
/// value at the mark, different wallet balances and entries. What must not
/// differ is what each trader holds (wallet plus equity), what the LPs hold
/// and what the other lines hold, up to rounding: a couple of units per
/// order, and for such a wallet the curvature of blending two entries,
/// bounded by a basis point of its size.
/// The differences, and the rounding the comparison allowed for.
fn settlement_diffs(before: &Snap, x: &Snap, y: &Snap, orders: &[(u8, Pubkey)], b: &Batch, m: usize) -> (Vec<String>, i128) {
    let mut out = vec![];
    let both: Vec<Pubkey> = orders
        .iter()
        .map(|o| o.1)
        .filter(|&w| self_netting(&[(0, w)], b))
        .collect();
    let mut tol = 2 * orders.len() as i128 + 2;
    for (t, (a, c)) in x.trader_usdc.iter().zip(&y.trader_usdc).enumerate() {
        let value = |s: &Snap, w: u64| {
            let mut v = w as i128;
            for (mm, mk) in s.markets.iter().enumerate() {
                let valued = unwind::aum::accrued_to(mk, &s.pool, s.now).expect("accrue");
                if let Some(q) = s.positions[mm][t].as_ref().filter(|q| q.is_open()) {
                    v += position_terms(&valued, q, s.oracle[mm]).2;
                }
            }
            v
        };
        let (va, vc) = (value(x, *a), value(y, *c));
        let size = x.positions[m][t].as_ref().map_or(0, |q| q.size_usd).max(y.positions[m][t].as_ref().map_or(0, |q| q.size_usd));
        // Blending a new entry into an old one is harmonic: the two orders
        // differ by about size x (move / entry)^2, with the move from the
        // old entry to the batch's price.
        let mine = if both.contains(&x.positions[m][t].as_ref().map_or(Pubkey::default(), |q| q.owner)) || both.contains(&y.positions[m][t].as_ref().map_or(Pubkey::default(), |q| q.owner)) {
            let mk = &before.markets[m];
            let moved = before.positions[m][t].as_ref().filter(|q| q.is_open()).map_or(0.0, |q| {
                let e = mk.adjust_entry_price(q.entry_price, q.entry_price_factor).unwrap_or(1).max(1) as f64;
                let p = [b.buy_price, b.sell_price, before.oracle[m]].iter().map(|&p| (p as f64 - e).abs() / e).fold(0.0, f64::max);
                p * p
            });
            (size as f64 * moved) as i128 + size as i128 / 10_000
        } else {
            0
        };
        // Every fill blended into a position rounds its entry by a unit,
        // worth size / entry, and which blend rounds where depends on order.
        let owner = x.positions[m][t].as_ref().or(y.positions[m][t].as_ref()).map(|q| q.owner);
        let fills = owner.map_or(0, |w| orders.iter().filter(|o| o.1 == w).count()) as i128;
        let entry = [x, y]
            .iter()
            .filter_map(|s| s.positions[m][t].as_ref().filter(|q| q.is_open()).map(|q| q.entry_price))
            .min()
            .unwrap_or(u64::MAX)
            .max(1) as i128;
        let mine = mine + fills * (2 * size as i128 / entry + 2);
        tol += mine;
        if (va - vc).abs() > 2 * orders.len() as i128 + 2 + mine {
            out.push(format!("trader {t} holds {va} reversed vs {vc} in order"));
        }
    }
    let (lx, tx, ox) = value_split(x);
    let (ly, ty, oy) = value_split(y);
    if (tx - ty).abs() > tol {
        out.push(format!("traders hold {tx} reversed vs {ty} in order (tolerance {tol})"));
    }
    if ((lx + ox) - (ly + oy)).abs() > tol {
        out.push(format!("the pool holds {} reversed vs {} in order (tolerance {tol})", lx + ox, ly + oy));
    }
    (out, tol)
}

/// What a market's backers hold: their USDC, less what the open book owes
/// out of their backing first (`book_split`).
fn backers_value(s: &Snap) -> i128 {
    s.pool.backing_usd as i128 + (0..s.markets.len()).map(|m| book_split(s, m).1).sum::<i128>()
}

/// Whether some wallet has both an open and a close in the batch.
fn self_netting(orders: &[(u8, Pubkey)], b: &Batch) -> bool {
    orders.iter().any(|&(_, w)| {
        let mine: Vec<_> = b.orders.iter().filter(|o| o.is_active() && o.owner == w).collect();
        mine.iter().any(|o| o.reduces()) && mine.iter().any(|o| !o.reduces())
    })
}

/// One of the market's parameters changed, the rest as they stand.
pub fn tweak_params(mk: &Market, field: u8, value: u16) -> unwind::instructions::MarketParams {
    let mut p = unwind::instructions::MarketParams {
        symbol: mk.symbol,
        feed_id: mk.feed_id,
        max_price_age_sec: mk.max_price_age_sec,
        max_conf_bps: mk.max_conf_bps,
        max_leverage_bps: mk.max_leverage_bps,
        maintenance_margin_bps: mk.maintenance_margin_bps,
        liquidation_fee_bps: mk.liquidation_fee_bps,
        open_fee_bps: mk.open_fee_bps,
        close_fee_bps: mk.close_fee_bps,
        min_position_usd: mk.min_position_usd,
        max_oi_long_usd: mk.max_oi_long_usd,
        max_oi_short_usd: mk.max_oi_short_usd,
        pnl_reserve_bps: mk.pnl_reserve_bps,
        base_spread_bps: mk.base_spread_bps,
        conf_spread_mult_bps: mk.conf_spread_mult_bps,
        max_spread_bps: mk.max_spread_bps,
        closed_session_leverage_bps: mk.closed_session_leverage_bps,
        closed_session_oi_mult_bps: mk.closed_session_oi_mult_bps,
        max_funding_rate_bps_per_hour: mk.max_funding_rate_bps_per_hour,
        funding_k_bps: mk.funding_k_bps,
        borrow_rate_bps_per_hour: mk.borrow_rate_bps_per_hour,
        price_source: mk.price_source,
        observation: mk.observation,
    };
    match field % 8 {
        0 => p.funding_k_bps = value % 20_000,
        1 => p.max_funding_rate_bps_per_hour = value % 500,
        2 => p.borrow_rate_bps_per_hour = value % 50,
        3 => {
            p.open_fee_bps = value % 100;
            p.close_fee_bps = (value / 100) % 100;
        }
        4 => p.maintenance_margin_bps = 220 + value % 1_500,
        5 => p.max_leverage_bps = 10_000 + (value as u32 * 4) % 200_000,
        6 => p.min_position_usd = (value as u64 % 500 + 1) * USD,
        _ => {
            let cap = (value as u64 % 100 + 1) * 10_000 * USD;
            p.max_oi_long_usd = cap;
            p.max_oi_short_usd = cap;
        }
    }
    p
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
/// reach its remaining budget (see `budget_can_bind`). There the payable
/// value depends on settlement order by design, and the first long run found
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

/// How far splits may have scaled up the rounding a side's average entry
/// carries. `rescale_market` multiplies the stored average by the ratio, so
/// a unit of rounding from before a 5-for-1 reverse split is five after it;
/// the factor bounds the product of every ratio since listing, and ten
/// covers a split down followed by one back up.
fn split_amplification(mk: &Market) -> i128 {
    if mk.split_epoch == 0 {
        return 1;
    }
    let one = unwind::state::PRICE_FACTOR_ONE;
    10 * (mk.price_factor.div_ceil(one).max(1) as i128)
}

/// After a split, a side's average entry and its positions' entries are
/// rescaled separately (`rescale_market` and `adjust_entry_price`), each
/// rounding on its own, and with the moment sums emptied a close takes its
/// size out of the average by the old harmonic rule. Taking a large position
/// out leaves the difference on what remains, magnified by how much left.
/// Bounded here at ten basis points of the side's size and of its value at
/// `price`: far past rounding before a split, and after one the aggregates
/// are the documented old rule.
fn split_drift(mk: &Market, price: u64) -> i128 {
    if mk.split_epoch == 0 {
        return 0;
    }
    [(mk.long_size_usd, mk.long_avg_entry_price), (mk.short_size_usd, mk.short_avg_entry_price)]
        .iter()
        .map(|&(sz, avg)| (sz as i128 + sz as i128 * price as i128 / avg.max(1) as i128) / 1_000 + 1)
        .sum()
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
                .map(|&(sz, avg)| split_amplification(mk) * (2 * (sz as i128) * price / (avg.max(1) as i128) / (avg.max(1) as i128) + 2))
                .sum::<i128>()
                + split_drift(mk, price as u64)
        })
        .sum()
}

/// A deposit or a claim never takes value from the LPs who stay: their
/// shares are worth at least as much after it as before, at the oracle
/// with funding brought up to now. A deposit is priced at whichever of the
/// oracle and risk price makes the pool worth more, and a claim at whichever
/// makes it worth less (`aum::lp_pnl_against_the_mover`), so either way the
/// mover pays the difference. A claim's tokens in kind leave the LPs'
/// holdings with it, at their oracle value.
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
        // the other side of the trade, and each token paid in kind rounds
        // its own unit, which is the slack.
        let slack = sb.max(sa) * (1 + before.custodies.len() as i128);
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
/// (`backing::book_unback`), USDC and in-kind tokens at their budget weight.
pub fn check_unback(after: &Snap, m: usize) -> Vec<Violation> {
    let mut v = vec![];
    let mk = &after.markets[m];
    let cover = mk.backing_usd as u128 + after.in_kind_weighted(m);
    ensure!(v, mk.remaining_budget_usd() as u128 <= cover, "budget_follows_backing_out",
        "market[{m}] remaining budget {} > backing {} plus weighted tokens {}", mk.remaining_budget_usd(), mk.backing_usd,
        cover - mk.backing_usd as u128);
    v
}

/// A split changes the terms prices are quoted in and nothing else
/// (docs/corporate-actions.md): every open position is worth what it was,
/// resting limits and triggers move with the price, and so does the risk
/// price.
pub fn check_split(before: &Snap, after: &Snap, m: usize, num: u64, den: u64) -> Vec<Violation> {
    let mut v = vec![];
    let (mb, ma) = (&before.markets[m], &after.markets[m]);
    ensure!(v, ma.price_factor == mb.price_factor * num as u128 / den as u128, "split_factor",
        "market[{m}] factor {} -> {} for {num}/{den}", mb.price_factor, ma.price_factor);
    let scaled = |x: u64| (x as u128 * num as u128 / den as u128) as i128;
    ensure!(v, (ma.risk_price as i128 - scaled(mb.risk_price).max(1)).abs() <= 1, "split_moves_risk_price",
        "market[{m}] risk price {} -> {} for {num}/{den}", mb.risk_price, ma.risk_price);
    for (t, (pb, pa)) in before.positions[m].iter().zip(&after.positions[m]).enumerate() {
        let (Some(pb), Some(pa)) = (pb, pa) else { continue };
        if !pb.is_open() {
            continue;
        }
        let (xb, _, _) = position_terms(mb, pb, before.oracle[m]);
        let (xa, _, _) = position_terms(ma, pa, after.oracle[m]);
        let entry = ma.adjust_entry_price(pa.entry_price, pa.entry_price_factor).unwrap_or(1).max(1) as i128;
        // One unit of rounding in the price, worth size / entry, and in the
        // entry, worth size x price / entry^2; the entry before the split
        // rounded in units this ratio makes larger.
        let p = after.oracle[m] as i128;
        let ratio = (num / den).max(1) as i128;
        let slack = 2 * ratio * pa.size_usd as i128 * (entry + p) / entry / entry + 4;
        ensure!(v, (xa as i128 - xb as i128).abs() <= slack, "split_keeps_position_value",
            "market[{m}] trader {t}: pnl {xb} before the {num}/{den} split, {xa} after (slack {slack})");
    }
    for (ob, oa) in before.batches[m].orders.iter().zip(after.batches[m].orders.iter()) {
        if ob.is_active() {
            ensure!(v, (oa.price as i128 - scaled(ob.price).max(1)).abs() <= 1, "split_moves_resting_limits",
                "market[{m}] limit {} -> {} for {num}/{den}", ob.price, oa.price);
        }
    }
    for ((k, ob), (_, oa)) in before.orders.iter().zip(&after.orders) {
        if k.1 != m {
            continue;
        }
        let tb = ob.trigger_at(mb.price_factor).unwrap_or(0);
        let ta = oa.trigger_at(ma.price_factor).unwrap_or(0);
        // Each reading rebases from the price as placed, so the one before
        // carried its own unit of rounding, which this ratio scales.
        let slack = (num / den) as i128 + 1;
        ensure!(v, (ta as i128 - scaled(tb).max(1)).abs() <= slack, "split_moves_triggers",
            "trigger {k:?}: {tb} -> {ta} for {num}/{den}");
    }
    v
}
