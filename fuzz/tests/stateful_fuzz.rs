//! Stateful fuzz harness for the `unwind` program.
//!
//! The real compiled program (`target/deploy/unwind.so`, built with
//! `anchor build -- --features devnet`) runs in litesvm against a pool
//! bootstrapped the way `scripts/bootstrap-localnet.ts` does it. proptest
//! generates sequences of actions (orders, clears, settlements, price moves
//! and gaps, clock warps, funding, liquidations, LP deposits and two-step
//! withdrawals, backing in and out), and after every transaction that lands
//! the money invariants in `support/model.rs` are checked against the
//! accounts. A failing sequence is shrunk to a minimal one and printed.
//!
//! Defaults run in about a minute; longer runs take environment variables:
//!
//! ```text
//! FUZZ_CASES=2000 FUZZ_STEPS=120 cargo test --release --test stateful_fuzz -- --nocapture
//! ```
//!
//! `FUZZ_SEED` fixes proptest's RNG seed for a reproducible run. Failing
//! cases are persisted under `regressions/` and replayed first on every run.

mod support;

use proptest::prelude::*;
use proptest::test_runner::{Config, FileFailurePersistence, RngAlgorithm, TestRng, TestRunner};
use std::sync::{Mutex, OnceLock};
use support::env::Env;
use support::model::{action_strategy, Action, Runner, Stats};

fn env_usize(name: &str, default: usize) -> usize {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).filter(|v| *v != 0).unwrap_or(default)
}

/// The bootstrapped fixture, built once and cloned for every case.
fn fixture() -> Env {
    static FIXTURE: OnceLock<Env> = OnceLock::new();
    FIXTURE.get_or_init(Env::bootstrap).clone()
}

/// Runs one sequence from the fixture. `Err` carries the failure report.
fn run_case(actions: &[Action], stats: Option<&Mutex<Stats>>) -> Result<(), String> {
    let mut r = Runner::new(fixture());
    let out = r.run(actions).map_err(|f| f.to_string());
    if let Some(s) = stats {
        s.lock().unwrap().merge(&r.stats);
    }
    out
}

fn config(cases: u32) -> Config {
    Config {
        cases,
        failure_persistence: Some(Box::new(FileFailurePersistence::Direct("regressions/stateful_fuzz.txt"))),
        // Shrinking replays whole sequences; bound it so a failure reports
        // in minutes rather than hours.
        max_shrink_iters: 4_000,
        ..Config::default()
    }
}

#[test]
fn stateful_fuzz() {
    let cases = env_usize("FUZZ_CASES", 64) as u32;
    let steps = env_usize("FUZZ_STEPS", 50);
    let stats = Mutex::new(Stats::default());
    let mut runner = match std::env::var("FUZZ_SEED").ok().and_then(|s| s.parse::<u64>().ok()) {
        Some(seed) => {
            let mut bytes = [0u8; 32];
            bytes[..8].copy_from_slice(&seed.to_le_bytes());
            TestRunner::new_with_rng(config(cases), TestRng::from_seed(RngAlgorithm::ChaCha, &bytes))
        }
        None => TestRunner::new(config(cases)),
    };
    let strategy = prop::collection::vec(action_strategy(), 1..=steps);
    let result = runner.run(&strategy, |actions| {
        run_case(&actions, Some(&stats)).map_err(TestCaseError::fail)
    });
    println!("{}", stats.lock().unwrap());
    if let Err(e) = result {
        panic!("{e}");
    }
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
        Crank { market: 0 },
        Warp { secs: 3_600, repost: true },
        AccrueFunding { market: 0 },
        MovePrice { market: 0, bps: -2_500 },
        StepRisk { market: 0, times: 8 },
        StepRisk { market: 0, times: 8 },
        StepRisk { market: 0, times: 8 },
        Liquidate { nth: 0, market: 0, catch_up: false },
        Close { nth: 0, market: 0, pct: 100, maker: false, limit_bps: 200, crank: false },
        Crank { market: 0 },
        LpDeposit { lp: 1, usd: 10_000 },
        LpRequest { lp: 0, pct: 10 },
        LpClaim { lp: 0, pct: 100, wait: true },
        Back { backer: 1, market: 0, usd: 5_000 },
        Unback { backer: 0, market: 0, pct: 50 },
    ];
    let mut r = Runner::new(fixture());
    if let Err(f) = r.run(&actions) {
        panic!("{f}");
    }
    println!("{}", r.stats);
    // Something must actually have traded, or the walkthrough proves nothing.
    let ok = |ix: &str| r.stats.per_ix.get(ix).map_or(0, |e| e.0);
    assert!(ok("settle_order") >= 2, "nothing settled:\n{}", r.stats);
    assert!(ok("add_liquidity") >= 1 && ok("claim_withdraw") >= 1, "LP paths did not run:\n{}", r.stats);
}
