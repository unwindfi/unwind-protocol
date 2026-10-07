//! Stateful fuzz harness for the `unwind` program.
//!
//! The real compiled program (`target/deploy/unwind.so`, built with
//! `anchor build -- --features devnet`) runs in litesvm against a pool
//! bootstrapped the way `scripts/bootstrap-localnet.ts` does it. proptest
//! generates sequences of actions over every instruction the program has
//! (see `Action` in `support/model.rs`), and after every transaction that
//! lands the invariants there are checked against the accounts. A failing
//! sequence is shrunk to a minimal one and printed.
//!
//! Two worlds: `Main`, a deep pool with Pyth, keeper-priced and folded
//! markets and two custodies, and `Thin`, a $20k pool with thin backing and
//! a funded insurance fund, where bad debt reaches the fund.
//!
//! Defaults run in about a minute; longer runs take environment variables:
//!
//! ```text
//! FUZZ_CASES=2000 FUZZ_STEPS=120 FUZZ_SEED=7 cargo test --release --test stateful_fuzz stateful_fuzz -- --nocapture
//! ```
//!
//! `FUZZ_SEED` fixes proptest's RNG seed for a reproducible run. Failing
//! cases are persisted under `regressions/` and replayed first on every run.

mod support;

use proptest::prelude::*;
use proptest::test_runner::{Config, FileFailurePersistence, RngAlgorithm, TestRng, TestRunner};
use std::sync::{Mutex, OnceLock};
use solana_signer::Signer;
use support::env::{Env, Fixture, USD};
use support::model::{action_strategy, Action, Runner, Stats};

fn env_usize(name: &str, default: usize) -> usize {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).filter(|v| *v != 0).unwrap_or(default)
}

/// The bootstrapped fixtures, built once and cloned for every case.
fn fixture(kind: Fixture) -> Env {
    static MAIN: OnceLock<Env> = OnceLock::new();
    static THIN: OnceLock<Env> = OnceLock::new();
    let cell = match kind {
        Fixture::Main => &MAIN,
        Fixture::Thin => &THIN,
    };
    cell.get_or_init(|| Env::bootstrap(kind)).clone()
}

/// Runs one sequence from the fixture. `Err` carries the failure report.
fn run_case(kind: Fixture, actions: &[Action], stats: Option<&Mutex<Stats>>) -> Result<(), String> {
    let mut r = Runner::new(fixture(kind));
    let out = r.run(actions).map_err(|f| f.to_string());
    if let Some(s) = stats {
        s.lock().unwrap().merge(&r.stats);
    }
    out
}

fn config(cases: u32, file: &'static str) -> Config {
    Config {
        cases,
        failure_persistence: Some(Box::new(FileFailurePersistence::Direct(file))),
        // Shrinking replays whole sequences; bound it so a failure reports
        // in minutes rather than hours.
        max_shrink_iters: 4_000,
        ..Config::default()
    }
}

fn fuzz(kind: Fixture, file: &'static str) {
    let cases = env_usize("FUZZ_CASES", 48) as u32;
    let steps = env_usize("FUZZ_STEPS", 50);
    let stats = Mutex::new(Stats::default());
    let started = std::time::Instant::now();
    let mut runner = match std::env::var("FUZZ_SEED").ok().and_then(|s| s.parse::<u64>().ok()) {
        Some(seed) => {
            let mut bytes = [0u8; 32];
            bytes[..8].copy_from_slice(&seed.to_le_bytes());
            bytes[8] = kind as u8;
            TestRunner::new_with_rng(config(cases, file), TestRng::from_seed(RngAlgorithm::ChaCha, &bytes))
        }
        None => TestRunner::new(config(cases, file)),
    };
    let strategy = prop::collection::vec(action_strategy(kind), 1..=steps);
    let result = runner.run(&strategy, |actions| run_case(kind, &actions, Some(&stats)).map_err(TestCaseError::fail));
    println!("{kind:?} fixture, {:.0}s", started.elapsed().as_secs_f64());
    println!("{}", stats.lock().unwrap());
    if let Err(e) = result {
        panic!("{e}");
    }
}

#[test]
fn stateful_fuzz() {
    fuzz(Fixture::Main, "regressions/stateful_fuzz.txt");
}

#[test]
fn stateful_fuzz_thin() {
    fuzz(Fixture::Thin, "regressions/stateful_fuzz_thin.txt");
}

/// A fixed sequence that walks the main paths end to end, so a change that
/// breaks the plumbing fails here plainly rather than as a fuzz failure.
#[test]
fn scripted_walkthrough() {
    use Action::*;
    let actions = vec![
        Open { trader: 0, market: 0, long: true, maker: false, size_usd: 5_000, lev_x: 5, limit_bps: 100, crank: false },
        Open { trader: 1, market: 0, long: false, maker: false, size_usd: 2_000, lev_x: 5, limit_bps: 100, crank: false },
        Open { trader: 2, market: 0, long: false, maker: true, size_usd: 1_000, lev_x: 3, limit_bps: -5, crank: false },
        Crank { market: 0, reorder: true },
        Warp { secs: 3_600, repost: true },
        AccrueFunding { market: 0 },
        MovePrice { market: 0, bps: -2_500 },
        StepRisk { market: 0, times: 8 },
        StepRisk { market: 0, times: 8 },
        StepRisk { market: 0, times: 8 },
        Liquidate { nth: 0, market: 0, catch_up: false },
        Close { nth: 0, market: 0, pct: 100, maker: false, limit_bps: 200, crank: false },
        Crank { market: 0, reorder: false },
        LpDeposit { lp: 1, usd: 10_000 },
        LpRequest { lp: 0, pct: 10 },
        LpClaim { lp: 0, pct: 100, wait: true },
        Back { backer: 1, market: 0, usd: 5_000, asset: 0 },
        Unback { backer: 0, market: 0, pct: 50 },
    ];
    let mut r = Runner::new(fixture(Fixture::Main));
    if let Err(f) = r.run(&actions) {
        panic!("{f}");
    }
    println!("{}", r.stats);
    // Something must actually have traded, or the walkthrough proves nothing.
    assert!(r.stats.ok("settle_order") >= 2, "nothing settled:\n{}", r.stats);
    assert!(r.stats.ok("add_liquidity") >= 1 && r.stats.ok("claim_withdraw") >= 1, "LP paths did not run:\n{}", r.stats);
}

/// Every instruction the fuzzer added, walked once in an order where each
/// lands: triggers, a split, in-kind backing, referrals and rewards, admin
/// changes, observed markets, a new generation and a full batch.
#[test]
fn scripted_new_paths() {
    use Action::*;
    let actions = vec![
        // Referrals: trader 1 takes a code, trader 0 names it before trading.
        ClaimCode { who: 6, code: 2 },
        SetReferrer { trader: 0, code: 2 },
        CreateTrader { who: 0 },
        // Trade on a Pyth market, a keeper-priced one and a folded one.
        Open { trader: 0, market: 0, long: true, maker: false, size_usd: 5_000, lev_x: 4, limit_bps: 100, crank: true },
        Open { trader: 1, market: 3, long: false, maker: false, size_usd: 2_000, lev_x: 2, limit_bps: 100, crank: true },
        Open { trader: 2, market: 4, long: true, maker: false, size_usd: 1_000, lev_x: 2, limit_bps: 100, crank: true },
        // A stop on trader 0's long, fired after the price moves through.
        PlaceTrigger { trader: 0, market: 0, slot: 0, open: false, long: true, size_usd: 3, lev_x: 1, trigger_bps: -500, above: false, expiry: 0 },
        // A limit open for trader 3, and one that expires.
        PlaceTrigger { trader: 3, market: 0, slot: 1, open: true, long: true, size_usd: 1_000, lev_x: 3, trigger_bps: -300, above: false, expiry: 0 },
        PlaceTrigger { trader: 4, market: 0, slot: 2, open: true, long: true, size_usd: 1_000, lev_x: 3, trigger_bps: -9_000, above: false, expiry: 5 },
        ExecTrigger { nth: 0, market: 0, through: true, crank: true },
        ExecTrigger { nth: 0, market: 0, through: true, crank: true },
        Warp { secs: 30, repost: true },
        ExecTrigger { nth: 0, market: 0, through: false, crank: false },
        SyncReferral { trader: 0 },
        SyncDeployer { market: 0 },
        ClaimRewards { who: 2 },
        ClaimRewards { who: 0 },
        AccruePoints { who: 18, show_lp: true },
        // A split with positions and a trigger standing.
        PlaceTrigger { trader: 1, market: 3, slot: 0, open: false, long: false, size_usd: 3, lev_x: 1, trigger_bps: 800, above: true, expiry: 0 },
        Split { market: 0, ratio: 1 },
        Split { market: 3, ratio: 2 },
        Split { market: 4, ratio: 0 },
        // In-kind backing behind the thin market.
        Back { backer: 1, market: 2, usd: 50_000, asset: 2 },
        Back { backer: 1, market: 2, usd: 10_000, asset: 1 },
        // Admin mid-flight.
        UpdateParams { market: 0, field: 0, value: 15_000 },
        SetSession { market: 1, session: 2 },
        SetSession { market: 1, session: 0 },
        SetBudget { market: 1, pct: 90 },
        PauseMarket { market: 1, paused: true },
        PauseMarket { market: 1, paused: false },
        PoolPauseBlip { trader: 0, market: 0 },
        CollectFees { protocol: true, pct: 50 },
        CollectFees { protocol: false, pct: 0 },
        FundInsurance { usd: 1_000 },
        AuthorityRoundTrip { via: 5 },
        SetPoints { enabled: true },
        KeeperBlip { market: 0 },
        Resize { which: 0 },
        Resize { which: 1 },
        Resize { which: 2 },
        Observe { market: 4, times: 3 },
        ThinPool { market: 4, pct: 1 },
        DeriveBudget { market: 3 },
        ListGeneration { feed: 0, lister: 0 },
        ListGeneration { feed: 1, lister: 2 },
        FillBatch { market: 1, maker: true },
        Adl { nth: 0, market: 0 },
        SyncBacking { market: 2 },
        MarkBacking { backer: 1, market: 2 },
    ];
    let mut r = Runner::new(fixture(Fixture::Main));
    if let Err(f) = r.run(&actions) {
        panic!("{f}");
    }
    println!("{}", r.stats);
    for ix in [
        "place_order",
        "execute_order",
        "apply_corporate_action",
        "set_referrer",
        "claim_referral_code",
        "sync_referral",
        "sync_deployer",
        "claim_rewards",
        "update_market_params",
        "set_session",
        "set_market_budget",
        "set_market_paused",
        "collect_protocol_fees",
        "collect_chain_fees",
        "fund_insurance",
        "nominate_authority",
        "accept_authority",
        "set_pool_points",
        "set_mark_keeper",
        "push_mark",
        "observe",
        "add_market",
        "create_batch",
        "resize_market",
        "resize_pool",
        "resize_trader",
    ] {
        assert!(r.stats.ok(ix) >= 1, "{ix} never landed:\n{}", r.stats);
    }
    assert!(r.stats.coverage.get("event: split applied").copied().unwrap_or(0) >= 3, "splits:\n{}", r.stats);
}

/// The thin pool, driven to a loss the fund has to pay: losers fill the
/// LPs' pockets, the LPs leave with it, and a winner the in-kind backing's
/// budget still covers is paid past the USDC backing and past what LP
/// liquidity holds.
fn insurance_draw_actions() -> Vec<Action> {
    use Action::*;
    let mut actions = vec![];
    // Losers first: shorts at 2x run over by a 60% gap and liquidated.
    for t in 0..4u8 {
        actions.push(Open { trader: t, market: 0, long: false, maker: false, size_usd: 3_500, lev_x: 2, limit_bps: 100, crank: true });
    }
    actions.push(MovePrice { market: 0, bps: 6_000 });
    actions.push(StepRisk { market: 0, times: 30 });
    for _ in 0..6 {
        actions.push(Liquidate { nth: 0, market: 0, catch_up: true });
    }
    // A winner, built a batch at a time: the pool quotes a few percent of
    // its liquidity per batch.
    for _ in 0..5 {
        actions.push(Open { trader: 5, market: 0, long: true, maker: false, size_usd: 1_000, lev_x: 5, limit_bps: 100, crank: true });
    }
    // The LPs leave with everything the pool lets go.
    actions.push(LpDrain { lp: 0 });
    actions.push(LpDrain { lp: 1 });
    // The winner's price goes up fourfold; it closes.
    actions.push(MovePrice { market: 0, bps: 20_000 });
    actions.push(MovePrice { market: 0, bps: 3_333 });
    actions.push(StepRisk { market: 0, times: 30 });
    actions.push(Close { nth: 0, market: 0, pct: 100, maker: false, limit_bps: 400, crank: true });
    actions
}

/// The fund, and only the fund, is drawn, after the market's USDC backing
/// and the LPs' liquidity are gone (docs/loss-budget.md).
#[test]
fn scripted_insurance_draw() {
    let mut r = Runner::new(fixture(Fixture::Thin));
    if let Err(f) = r.run(&insurance_draw_actions()) {
        panic!("{f}");
    }
    if std::env::var("FUZZ_TRAIL").is_ok() {
        println!("{}", r.trail());
    }
    println!("{}", r.stats);
    let drawn = r.stats.coverage.get("event: insurance drawn").copied().unwrap_or(0);
    assert!(drawn >= 1, "the fund was never drawn:\n{}", r.stats);
}

/// FINDING 1 (fuzz/FINDINGS.md): the in-kind sync after a loss the fund
/// helped pay handed the LPs tokens for the fund's part too.
///
/// `sync_backing` paid the LPs tokens worth everything past the USDC
/// backing (`lp_borne_usd`), but when LP liquidity ran out the fund paid
/// part of that, and nothing repaid the fund. Fixed: the market records
/// what the fund paid (`Market::insurance_drawn_usd`) and the sync repays
/// the fund first, in tokens (`Custody::insurance_amount`), and the LPs only
/// what is left.
#[test]
fn finding_in_kind_sync_repays_the_lps_for_the_funds_loss() {
    let mut r = Runner::new(fixture(Fixture::Thin));
    let actions = insurance_draw_actions();
    if let Err(f) = r.run(&actions) {
        panic!("{f}");
    }
    let before = r.env.pool_state();
    let drawn = r.env.market_state(0).insurance_drawn_usd;
    if let Err(f) = r.run(&[Action::SyncBacking { market: 0 }]) {
        panic!("{f}");
    }
    let after = r.env.pool_state();
    let c = r.env.custody_state(1);
    let usd = |amount: u64| amount as u128 * r.env.custodies[1].price as u128 / 1_000_000_000;
    let (lp_tokens_usd, fund_tokens_usd) = (usd(c.lp_amount), usd(c.insurance_amount));
    let m = r.env.market_state(0);
    println!(
        "fund {} -> {} in USDC, plus {fund_tokens_usd} of SOLX in kind; LP liquidity {}; LPs hold {lp_tokens_usd} of SOLX in kind; \
         market net loss {} of which USDC backing drew {}; fund unrepaid {drawn} -> {}",
        before.insurance_usd, after.insurance_usd, after.liquidity_usd, m.net_loss_usd, m.backing_drawn_usd,
        m.insurance_drawn_usd
    );
    // Past the USDC backing the market cost `lp_borne`; the fund paid more
    // than that of it, so the LPs are owed nothing in kind and the fund all
    // the tokens owe.
    let lp_borne = (m.net_loss_usd as i128 - m.backing_drawn_usd as i128).max(0) as u128;
    let fund_paid = (5_000 * USD as u128).saturating_sub(after.insurance_usd as u128);
    assert!(
        lp_tokens_usd <= lp_borne.saturating_sub(fund_paid) + 1_000_000,
        "the LPs were handed {lp_tokens_usd} in kind for a loss of {lp_borne} past the USDC backing, \
         {fund_paid} of which the fund paid"
    );
    assert!(drawn > 4_990 * USD, "the market records what the fund paid: {drawn}");
    assert!(fund_tokens_usd + 1_000_000 >= lp_borne, "the fund was repaid {fund_tokens_usd} of the {lp_borne} the tokens owe");
    assert_eq!(m.insurance_drawn_usd as u128, drawn as u128 - lp_borne, "and is owed the rest");
}


/// FINDING 2 (fuzz/FINDINGS.md): within one sealed batch, the order orders
/// were settled in moved value between a market's backers and the LPs.
///
/// A winner and a loser close in the same batch. Settled winner first, the
/// winner's profit drew the backing and the loser's loss then repaid it
/// (`restore_backing`); settled loser first, the loss went to the LPs (no
/// backing drawn yet) and the winner's profit then drew the backing for
/// good. Settlement is permissionless and the settler picks the order, so
/// whoever cranked picked who paid. Fixed: a batch's closes are netted
/// (`Market::settle_backing_in_batch`).
#[test]
fn finding_settlement_order_moves_value_between_backers_and_lps() {
    use Action::*;
    let mut r = Runner::new(fixture(Fixture::Thin));
    let setup = [
        Cross { maker: 0, taker: 1, market: 0, maker_long: false, size_usd: 2_000, lev_x: 2, crank: true, checks: false },
        MovePrice { market: 0, bps: 300 },
        // Trader 0 (short) and trader 1 (long) both close in one batch.
        Close { nth: 0, market: 0, pct: 100, maker: false, limit_bps: 200, crank: false },
        Close { nth: 1, market: 0, pct: 100, maker: false, limit_bps: 200, crank: false },
        Clear { market: 0, permute: false },
    ];
    if let Err(f) = r.run(&setup) {
        panic!("{f}");
    }
    let b = r.env.batch_state(0);
    let active: Vec<(u8, _)> = (0..b.orders.len()).filter(|&i| b.orders[i].is_active()).map(|i| (i as u8, b.orders[i].owner)).collect();
    assert_eq!(active.len(), 2, "both closes should be in the sealed batch");
    let settle = |order: &[(u8, _)]| {
        let mut e = r.env.clone();
        for &(i, owner) in order {
            let ix = e.ix_settle_order(0, i, owner);
            assert!(matches!(e.send(ix), support::env::TxOutcome::Ok));
        }
        let (p, m) = (e.pool_state(), e.market_state(0));
        (p.liquidity_usd, m.backing_usd)
    };
    let forward = settle(&active);
    let reversed: Vec<_> = active.iter().rev().copied().collect();
    let backward = settle(&reversed);
    println!("settled in index order: LP liquidity {}, backing {}", forward.0, forward.1);
    println!("settled in reverse:     LP liquidity {}, backing {}", backward.0, backward.1);
    assert_eq!(forward, backward, "the settler's choice of order moved value between the LPs and the backers");
}



/// FINDING 3 (fuzz/FINDINGS.md): a split that rounds a position's entry
/// price to zero leaves its close unsettleable, and with it the batch.
///
/// `rescale_market` moves the risk and last prices with a floor of one unit,
/// but a position's entry is rebased lazily (`Market::adjust_entry_price`)
/// with no floor, and the side's average entry (`mul_div_u64`) has none
/// either. Below `denominator` units an entry rebased to zero, and
/// `position_pnl_usd` refuses a zero entry, so settling the position's
/// close was refused and the sealed batch could not roll. Fixed: both now
/// floor at one unit, as `rescale_price` does.
#[test]
fn finding_split_to_a_zero_entry_blocks_settlement() {
    use Action::*;
    let mut r = Runner::new(fixture(Fixture::Thin));
    let actions = [
        // BETA marked at five millionths of a dollar: five units.
        MovePrice { market: 1, bps: -9_999 },
        MovePrice { market: 1, bps: -9_975 },
        Open { trader: 0, market: 1, long: true, maker: false, size_usd: 10, lev_x: 1, limit_bps: 100, crank: true },
        // A 1-for-10 split: the entry rebases to under one unit.
        Split { market: 1, ratio: 4 },
        Close { nth: 0, market: 1, pct: 100, maker: false, limit_bps: 0, crank: true },
    ];
    let res = r.run(&actions);
    let q = r.env.position_state(1, &r.env.traders[0].pubkey()).unwrap();
    let m = r.env.market_state(1);
    println!(
        "entry {} at factor {}, market factor {}, rebased {:?}, oracle {}",
        q.entry_price,
        q.entry_price_factor,
        m.price_factor,
        m.adjust_entry_price(q.entry_price, q.entry_price_factor),
        r.env.oracle_price(1)
    );
    if let Err(f) = res {
        panic!("{f}");
    }
}
