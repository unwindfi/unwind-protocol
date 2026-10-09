//! The world the stateful fuzz harness drives: the real compiled `unwind` and
//! `mock_pyth` programs loaded into litesvm, a pool bootstrapped the way
//! `scripts/bootstrap-localnet.ts` does it, and one builder per instruction.
//!
//! Everything here is plumbing. It decides nothing about what is correct;
//! that lives with the invariants in `model.rs`.
//!
//! Three shortcuts, all outside the program under test:
//!
//! - Prices are written straight into the `PriceUpdateV2` account a market
//!   reads, owned by `mock_pyth`, rather than posted through it. A devnet
//!   build of `mock_pyth` only takes posts from the relay key, which a test
//!   cannot sign as. The bytes are the same either way, and `unwind::oracle`
//!   still checks owner, discriminator, verification, feed id and staleness.
//! - USDC, LP and custody token accounts and their mints are written directly
//!   too, so the bootstrap needs no SPL instructions of its own.
//! - The AMM pools observed markets read are fake Raydium CLMM accounts: the
//!   right owner, discriminator and the handful of fields `unwind::amm` reads
//!   (mints, decimals, liquidity, square-root price), written directly. The
//!   observation, its seasoning, the keeper's pushes and the depth tracking
//!   all run in the program as they would against a real pool.

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::bpf_loader_upgradeable;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction, InstructionError};
use anchor_lang::solana_program::program_option::COption;
use anchor_lang::solana_program::program_pack::Pack;
use anchor_lang::solana_program::sysvar::clock::Clock;
use anchor_lang::{AccountDeserialize, AnchorSerialize, InstructionData, ToAccountMetas};
use anchor_spl::token::spl_token;
use litesvm::LiteSVM;
use solana_account::Account;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;
use solana_transaction_error::TransactionError;
use unwind::constants::*;
use unwind::state::{Batch, Custody, Market, Observation, Order, Pool, Position, Trader};

pub const MOCK_PYTH_ID: Pubkey = anchor_lang::prelude::pubkey!("J1FKStdEnsAK69gV4G5nVTm6eZTquo5kwQdLCHctE2k4");
const COMPUTE_BUDGET_ID: Pubkey =
    anchor_lang::prelude::pubkey!("ComputeBudget111111111111111111111111111111");

/// Wallets that can hold positions. The first `ACTIVE_TRADERS` do most of the
/// trading; the rest are the crowd that fills a batch to its 64 orders, four
/// each, and one more to find it full.
pub const N_TRADERS: usize = 17;
pub const ACTIVE_TRADERS: usize = 8;
pub const N_LPS: usize = 2;
pub const N_BACKERS: usize = 2;
pub const USD: u64 = 1_000_000;
/// Trigger order slots the harness uses per (trader, market).
pub const ORDER_SLOTS: u8 = 4;
/// Referral codes the harness hands out: `code0` to `code3`.
pub const N_CODES: u8 = 4;

pub const TRADER_FUNDS: u64 = 200_000 * USD;
pub const LP_FUNDS: u64 = 2_000_000 * USD;
pub const BACKER_FUNDS: u64 = 500_000 * USD;
/// What each backer holds of each custody token, in whole tokens.
pub const BACKER_TOKENS: u64 = 1_000_000;

const START_UNIX: i64 = 1_800_000_000;
const START_SLOT: u64 = 1_000;

/// Confidence posted with every price, in bps of it: inside every market's
/// `max_conf_bps`, and wide enough to put a confidence term in the spread.
pub const CONF_BPS: u64 = 10;

/// Liquidity of a fake CLMM pool: about $10M to move it 1% at a $100 price,
/// deep enough that the confidence it implies is nothing.
pub const DEEP_CLMM_LIQUIDITY: u128 = 200_000_000_000_000;

/// Where a market's mark comes from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    /// A Pyth `PriceUpdateV2` account.
    Pyth,
    /// An observed AMM pool whose mark the pool's keeper pushes.
    Keeper,
    /// An observed AMM pool folded into the mark by the permissionless crank.
    Folded,
}

/// One listed market and the price account behind it.
#[derive(Clone, Debug)]
pub struct MarketFx {
    pub symbol: &'static str,
    pub feed_id: [u8; 32],
    pub generation: u32,
    pub market: Pubkey,
    pub batch: Pubkey,
    /// What the market's instructions read as `price_update`: the Pyth
    /// account, or the observation for an observed market.
    pub price_account: Pubkey,
    /// The price the relay last posted or the keeper last pushed, or for a
    /// folded market the spot its fake pool sits at, `PRICE_SCALE`.
    pub price: u64,
    pub source: Source,
    /// The fake CLMM pool of an observed market.
    pub amm: Pubkey,
    /// What it was listed with.
    pub spec: Spec,
}

/// A token backing may be held in, besides USDC.
#[derive(Clone, Debug)]
pub struct CustodyFx {
    pub symbol: &'static str,
    pub mint: Pubkey,
    pub custody: Pubkey,
    pub vault: Pubkey,
    pub decimals: u8,
    pub stable: bool,
    pub feed_id: [u8; 32],
    pub price_account: Pubkey,
    /// USD per whole token, `PRICE_SCALE`.
    pub price: u64,
    /// What was minted, all of it held by the backers at the start.
    pub supply: u64,
}

/// How a transaction ended.
#[derive(Clone, Debug)]
pub enum TxOutcome {
    Ok,
    /// The program refused it, with its `PerpError` name (or the token or
    /// Anchor code behind it).
    Rejected { name: String },
    /// The program panicked or ran out of compute: never an acceptable way
    /// to refuse, since a panic in a permissionless crank holds a market.
    Aborted { reason: String, logs: Vec<String> },
}

/// Which world a run starts from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fixture {
    /// $1.25M of LP capital, three Pyth markets (one thinly backed in USDC
    /// and $20k in kind), two observed ones (one keeper-priced, one
    /// folded), two custodies.
    Main,
    /// $20k of LP capital, two thinly backed Pyth markets (the first also
    /// backed $10k in kind) and a funded insurance fund: a loss can outrun
    /// the backing and the LPs and reach the fund here.
    Thin,
}

pub struct Env {
    pub fixture: Fixture,
    pub svm: LiteSVM,
    pub authority: Keypair,
    pub traders: Vec<Keypair>,
    pub lps: Vec<Keypair>,
    pub backers: Vec<Keypair>,
    pub usdc_mint: Pubkey,
    pub pool: Pubkey,
    pub vault: Pubkey,
    pub lp_mint: Pubkey,
    pub markets: Vec<MarketFx>,
    pub custodies: Vec<CustodyFx>,
    /// Trigger orders that may exist, `(trader, market, slot)`. The snapshot
    /// reads only these.
    pub trigger_keys: std::collections::BTreeSet<(usize, usize, u8)>,
    /// Logs of the last transaction that landed, for the events in them.
    pub last_logs: Vec<String>,
}

impl Clone for Env {
    fn clone(&self) -> Self {
        Env {
            fixture: self.fixture,
            svm: self.svm.clone(),
            authority: self.authority.insecure_clone(),
            traders: self.traders.iter().map(|k| k.insecure_clone()).collect(),
            lps: self.lps.iter().map(|k| k.insecure_clone()).collect(),
            backers: self.backers.iter().map(|k| k.insecure_clone()).collect(),
            usdc_mint: self.usdc_mint,
            pool: self.pool,
            vault: self.vault,
            lp_mint: self.lp_mint,
            markets: self.markets.clone(),
            custodies: self.custodies.clone(),
            trigger_keys: self.trigger_keys.clone(),
            last_logs: vec![],
        }
    }
}

/// `find_program_address`, remembered: the search is a curve check per
/// bump, and the harness derives the same few hundred addresses millions of
/// times.
fn find(seeds: &[&[u8]], program: &Pubkey) -> Pubkey {
    use std::cell::RefCell;
    use std::collections::HashMap;
    thread_local! { static CACHE: RefCell<HashMap<Vec<u8>, Pubkey>> = RefCell::new(HashMap::new()); }
    let mut k = program.to_bytes().to_vec();
    for s in seeds {
        k.push(s.len() as u8);
        k.extend_from_slice(s);
    }
    if let Some(p) = CACHE.with(|c| c.borrow().get(&k).copied()) {
        return p;
    }
    let p = Pubkey::find_program_address(seeds, program).0;
    CACHE.with(|c| c.borrow_mut().insert(k, p));
    p
}

static SENT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

pub fn pda(seeds: &[&[u8]]) -> Pubkey {
    find(seeds, &unwind::ID)
}

fn key(n: u8) -> Keypair {
    let mut seed = [0u8; 32];
    seed[0] = 0x5f;
    seed[1] = n;
    Keypair::new_from_array(seed)
}

/// The ATA-shaped address the harness uses for `owner`'s account of `mint`.
/// Any address works: the program checks mint and owner, not derivation.
pub fn token_account_address(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    find(&[b"fuzz-token", owner.as_ref(), mint.as_ref()], &MOCK_PYTH_ID)
}

/// The referral code `code{i}`, zero-padded.
pub fn code_bytes(i: u8) -> [u8; REFERRAL_CODE_LEN] {
    let mut c = [0u8; REFERRAL_CODE_LEN];
    let s = format!("code{i}");
    c[..s.len()].copy_from_slice(s.as_bytes());
    c
}

/// Names for the program's custom error codes, read from the source so they
/// stay in step with it.
fn error_names() -> Vec<String> {
    let src = include_str!("../../../programs/unwind/src/errors.rs");
    let body = &src[src.find("pub enum PerpError").expect("PerpError")..];
    let body = &body[body.find('{').unwrap() + 1..body.find("\n}").unwrap()];
    body.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with("#[") && !l.starts_with("//"))
        .map(|l| l.trim_end_matches(',').to_string())
        .collect()
}

pub fn error_name(code: u32) -> String {
    thread_local! { static NAMES: Vec<String> = error_names(); }
    if code >= 6000 {
        let i = (code - 6000) as usize;
        if let Some(n) = NAMES.with(|n| n.get(i).cloned()) {
            return n;
        }
    }
    // Below 100 is the token program (1 is insufficient funds); 100 to 5999
    // is Anchor's own (constraint failures and the like).
    if code < 100 {
        format!("token-{code}")
    } else {
        format!("anchor-{code}")
    }
}

/// `sqrt(price / 1e6) * 2^64`, the square-root price a CLMM pool with two
/// six-decimal tokens holds when token 1 (the dollar) per token 0 is `price`.
pub fn sqrt_price_x64(price: u64) -> u128 {
    let p = price as f64 / 1e6;
    (p.sqrt() * 18_446_744_073_709_551_616.0) as u128
}

/// Market parameters the harness lists with.
#[derive(Clone, Copy, Debug)]
pub struct Spec {
    pub symbol: &'static str,
    pub price: u64,
    pub max_leverage_bps: u32,
    pub mm_bps: u16,
    pub source: Source,
}

impl Env {
    // ------------------------------------------------------------ bootstrap

    pub fn bootstrap(fixture: Fixture) -> Env {
        let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../target/deploy");
        let unwind_so = std::fs::read(format!("{root}/unwind.so")).unwrap_or_else(|e| {
            panic!("{root}/unwind.so: {e}. Build it first: `anchor build -- --features devnet`")
        });
        let pyth_so = std::fs::read(format!("{root}/mock_pyth.so")).expect("mock_pyth.so");

        let mut svm = LiteSVM::new()
            .with_sigverify(false)
            .with_blockhash_check(false)
            .with_transaction_history(0);
        let mut clock: Clock = svm.get_sysvar();
        clock.slot = START_SLOT;
        clock.unix_timestamp = START_UNIX;
        svm.set_sysvar(&clock);

        let authority = key(0);
        Self::deploy_upgradeable(&mut svm, unwind::ID, &unwind_so, authority.pubkey());
        svm.add_program(MOCK_PYTH_ID, &pyth_so).expect("mock_pyth");

        let traders: Vec<Keypair> = (0..N_TRADERS as u8).map(|i| key(10 + i)).collect();
        let lps: Vec<Keypair> = (0..N_LPS as u8).map(|i| key(30 + i)).collect();
        let backers: Vec<Keypair> = (0..N_BACKERS as u8).map(|i| key(50 + i)).collect();
        for k in std::iter::once(&authority).chain(&traders).chain(&lps).chain(&backers) {
            svm.airdrop(&k.pubkey(), 1_000_000_000_000).expect("airdrop");
        }

        let usdc_mint = key(99).pubkey();
        let pool = pda(&[POOL_SEED, usdc_mint.as_ref()]);
        let vault = pda(&[POOL_VAULT_SEED, pool.as_ref()]);
        let lp_mint = pda(&[LP_MINT_SEED, pool.as_ref()]);

        let mut env = Env {
            fixture,
            svm,
            authority,
            traders,
            lps,
            backers,
            usdc_mint,
            pool,
            vault,
            lp_mint,
            markets: vec![],
            custodies: vec![],
            trigger_keys: Default::default(),
            last_logs: vec![],
        };

        // USDC: everybody's balance is minted up front, so the mint's supply
        // is the total the harness ever puts in.
        let mut balances: Vec<(Pubkey, u64)> = vec![(env.authority.pubkey(), 0)];
        balances.extend(env.traders.iter().map(|k| (k.pubkey(), TRADER_FUNDS)));
        balances.extend(env.lps.iter().map(|k| (k.pubkey(), LP_FUNDS)));
        balances.extend(env.backers.iter().map(|k| (k.pubkey(), BACKER_FUNDS)));
        let supply: u64 = balances.iter().map(|b| b.1).sum();
        env.write_mint(usdc_mint, env.authority.pubkey(), supply, 6);
        for (owner, amount) in balances {
            env.write_token_account(owner, usdc_mint, amount);
        }

        env.expect_ok(env.ix_initialize_pool(), "initialize_pool");
        for k in env.lps.iter().map(|k| k.pubkey()).collect::<Vec<_>>() {
            env.write_token_account(k, lp_mint, 0);
        }

        let (specs, backing, lp_seed, insurance): (Vec<Spec>, Vec<u64>, Vec<u64>, u64) = match fixture {
            Fixture::Main => (
                // Different leverage and margin, so liquidation, the band and
                // the budget meet different numbers in each.
                vec![
                    Spec { symbol: "ALPHA", price: 100 * USD, max_leverage_bps: 100_000, mm_bps: 500, source: Source::Pyth },
                    Spec { symbol: "BETA", price: 20 * USD, max_leverage_bps: 200_000, mm_bps: 250, source: Source::Pyth },
                    Spec { symbol: "GAMMA", price: 3_000 * USD, max_leverage_bps: 50_000, mm_bps: 1_000, source: Source::Pyth },
                    Spec { symbol: "KEEP", price: 50 * USD, max_leverage_bps: 50_000, mm_bps: 500, source: Source::Keeper },
                    Spec { symbol: "FOLD", price: 4 * USD, max_leverage_bps: 50_000, mm_bps: 500, source: Source::Folded },
                ],
                // One deep, one middling and one thin enough that its winners
                // can outrun it; the observed ones in between.
                vec![100_000 * USD, 25_000 * USD, 8_000 * USD, 20_000 * USD, 15_000 * USD],
                vec![1_000_000 * USD, 250_000 * USD],
                0,
            ),
            Fixture::Thin => (
                vec![
                    Spec { symbol: "ALPHA", price: 100 * USD, max_leverage_bps: 100_000, mm_bps: 500, source: Source::Pyth },
                    Spec { symbol: "BETA", price: 20 * USD, max_leverage_bps: 200_000, mm_bps: 250, source: Source::Pyth },
                ],
                vec![2_000 * USD, 1_000 * USD],
                vec![15_000 * USD, 5_000 * USD],
                5_000 * USD,
            ),
        };

        if fixture == Fixture::Main {
            env.expect_ok(env.ix_set_mark_keeper(env.authority.pubkey()), "set_mark_keeper");
        }
        env.add_custody("USDT", true, 6, USD);
        env.add_custody("SOLX", false, 9, 150 * USD);

        for spec in specs {
            let i = env.list(spec, 1, None);
            env.expect_ok(env.ix_create_batch(i), "create_batch");
            match spec.source {
                Source::Pyth => {}
                Source::Keeper => {
                    env.expect_ok(env.ix_create_observation(i), "create_observation");
                    env.expect_ok(env.ix_push_mark(i, spec.price), "push_mark");
                }
                Source::Folded => {
                    env.expect_ok(env.ix_create_observation(i), "create_observation");
                }
            }
        }
        // Folded marks season the slow way: thirty readings over fifteen
        // minutes. Every other price is reposted afterwards.
        if env.markets.iter().any(|fx| fx.source == Source::Folded) {
            for _ in 0..=unwind::state::MIN_OBSERVATIONS {
                env.advance(32, 80);
                for m in 0..env.markets.len() {
                    if env.markets[m].source == Source::Folded {
                        env.expect_ok(env.ix_observe(m), "observe");
                    }
                }
            }
        }
        env.repost_feeds();
        for m in 0..env.markets.len() {
            if env.markets[m].source == Source::Keeper {
                let p = env.markets[m].price;
                env.expect_ok(env.ix_push_mark(m, p), "push_mark");
            }
        }

        // Referrals, before anyone trades (a referrer can only be named
        // before a wallet's first fill): trader 1 holds `code0`, named by
        // traders 2 and 3; trader 6 holds `code1`, named by trader 7. The
        // authority, which listed every market, gets its record to collect
        // listing rewards into.
        for (holder, code, referees) in [(1usize, 0u8, &[2usize, 3][..]), (6, 1, &[7][..])] {
            let k = env.traders[holder].insecure_clone();
            env.expect_ok(env.ix_claim_referral_code(&k, code_bytes(code)), "claim_referral_code");
            for &r in referees {
                let rk = env.traders[r].insecure_clone();
                env.expect_ok(env.ix_set_referrer(&rk, code_bytes(code), k.pubkey()), "set_referrer");
            }
        }
        let a = env.authority.insecure_clone();
        env.expect_ok(env.ix_create_trader(&a), "create_trader");

        // Backing first: a market with no budget cannot open a position.
        for (m, amount) in backing.into_iter().enumerate() {
            env.expect_ok(env.ix_back_market(0, m, 0, amount), "back_market");
        }
        for (i, amount) in lp_seed.into_iter().enumerate() {
            env.expect_ok(env.ix_checkpoint_aum(true, &[]), "checkpoint_aum");
            env.expect_ok(env.ix_add_liquidity(i, amount), "add_liquidity");
        }
        if insurance > 0 {
            env.expect_ok(env.ix_fund_insurance(1, insurance), "fund_insurance");
        }
        // In-kind backing past the USDC behind one market (the first in the
        // thin pool, the thinly backed GAMMA in the main one): the budget it
        // buys is what lets a loss outrun the USDC, so the LPs are paid in
        // kind, and in the thin pool outrun the LPs too and reach the fund.
        let (m, usd) = match fixture {
            Fixture::Main => (2, 20_000),
            Fixture::Thin => (0, 10_000),
        };
        let sol = usd as u128 * USD as u128 * 1_000_000_000 / (150 * USD) as u128;
        env.expect_ok(env.ix_back_market(1, m, 2, sol as u64), "back_market in kind");
        env
    }

    /// Lists `spec` at `generation`, as the authority or, with `lister`, as
    /// that trader inside the permissionless bounds. Returns its index, or
    /// the refusal.
    pub fn try_list(&mut self, spec: Spec, generation: u32, lister: Option<usize>) -> Result<usize, TxOutcome> {
        let i = self.markets.len();
        let fx = self.market_fx(spec, generation);
        self.markets.push(fx);
        if spec.source == Source::Pyth {
            // A later generation shares the feed; posting keeps them equal.
            self.post_price(i, spec.price);
        } else {
            let amm = self.markets[i].amm;
            self.write_clmm(amm, spec.price, DEEP_CLMM_LIQUIDITY);
        }
        let ix = self.ix_add_market(i, spec, lister);
        match self.send(ix) {
            TxOutcome::Ok => Ok(i),
            other => {
                self.markets.pop();
                Err(other)
            }
        }
    }

    pub fn list(&mut self, spec: Spec, generation: u32, lister: Option<usize>) -> usize {
        match self.try_list(spec, generation, lister) {
            Ok(i) => i,
            Err(e) => panic!("add_market {}: {e:?}", spec.symbol),
        }
    }

    fn market_fx(&self, spec: Spec, generation: u32) -> MarketFx {
        let (feed_id, amm) = match spec.source {
            Source::Pyth => {
                let mut f = [0u8; 32];
                f[..spec.symbol.len()].copy_from_slice(spec.symbol.as_bytes());
                (f, Pubkey::default())
            }
            _ => {
                let amm = Pubkey::find_program_address(&[b"clmm", spec.symbol.as_bytes()], &MOCK_PYTH_ID).0;
                (unwind::instructions::observed_feed_id(&amm), amm)
            }
        };
        let market = pda(&[MARKET_SEED, self.pool.as_ref(), &feed_id, &generation.to_le_bytes()]);
        let price_account = match spec.source {
            Source::Pyth => Pubkey::find_program_address(&[b"price", &feed_id], &MOCK_PYTH_ID).0,
            _ => pda(&[OBSERVATION_SEED, market.as_ref()]),
        };
        MarketFx {
            symbol: spec.symbol,
            feed_id,
            generation,
            market,
            batch: pda(&[BATCH_SEED, market.as_ref()]),
            price_account,
            price: spec.price,
            source: spec.source,
            amm,
            spec,
        }
    }

    fn add_custody(&mut self, symbol: &'static str, stable: bool, decimals: u8, price: u64) {
        let n = self.custodies.len() as u8;
        let mint = key(120 + n).pubkey();
        let mut feed_id = [0u8; 32];
        feed_id[..symbol.len()].copy_from_slice(symbol.as_bytes());
        let custody = pda(&[CUSTODY_SEED, self.pool.as_ref(), mint.as_ref()]);
        let per_backer = BACKER_TOKENS * 10u64.pow(decimals as u32);
        let supply = per_backer * N_BACKERS as u64;
        self.write_mint(mint, self.authority.pubkey(), supply, decimals);
        for k in self.backers.iter().map(|k| k.pubkey()).collect::<Vec<_>>() {
            self.write_token_account(k, mint, per_backer);
        }
        for k in self.lps.iter().map(|k| k.pubkey()).collect::<Vec<_>>() {
            self.write_token_account(k, mint, 0);
        }
        let fx = CustodyFx {
            symbol,
            mint,
            custody,
            vault: pda(&[CUSTODY_VAULT_SEED, custody.as_ref()]),
            decimals,
            stable,
            feed_id,
            price_account: Pubkey::find_program_address(&[b"price", &feed_id], &MOCK_PYTH_ID).0,
            price,
            supply,
        };
        self.custodies.push(fx);
        self.post_custody_price(n as usize, price);
        let ix = self.ix_add_custody(n as usize);
        self.expect_ok(ix, "add_custody");
    }

    /// Loads `elf` as an upgradeable program with `upgrade_authority`, which
    /// `initialize_pool` reads off its program data account.
    fn deploy_upgradeable(svm: &mut LiteSVM, program_id: Pubkey, elf: &[u8], upgrade_authority: Pubkey) {
        let programdata = Pubkey::find_program_address(&[program_id.as_ref()], &bpf_loader_upgradeable::ID).0;
        // UpgradeableLoaderState::ProgramData, bincode: u32 tag 3, u64 slot,
        // Option<Pubkey>.
        let mut pd = Vec::with_capacity(45 + elf.len());
        pd.extend_from_slice(&3u32.to_le_bytes());
        pd.extend_from_slice(&0u64.to_le_bytes());
        pd.push(1);
        pd.extend_from_slice(upgrade_authority.as_ref());
        pd.extend_from_slice(elf);
        let rent = svm.minimum_balance_for_rent_exemption(pd.len());
        svm.set_account(
            programdata,
            Account { lamports: rent, data: pd, owner: bpf_loader_upgradeable::ID, executable: false, rent_epoch: 0 },
        )
        .expect("programdata");
        // UpgradeableLoaderState::Program: u32 tag 2, the program data address.
        let mut p = Vec::with_capacity(36);
        p.extend_from_slice(&2u32.to_le_bytes());
        p.extend_from_slice(programdata.as_ref());
        let rent = svm.minimum_balance_for_rent_exemption(p.len());
        svm.set_account(
            program_id,
            Account { lamports: rent, data: p, owner: bpf_loader_upgradeable::ID, executable: true, rent_epoch: 0 },
        )
        .expect("program");
    }

    fn write_mint(&mut self, mint: Pubkey, authority: Pubkey, supply: u64, decimals: u8) {
        let m = spl_token::state::Mint {
            mint_authority: COption::Some(authority),
            supply,
            decimals,
            is_initialized: true,
            freeze_authority: COption::None,
        };
        let mut data = vec![0u8; spl_token::state::Mint::LEN];
        m.pack_into_slice(&mut data);
        self.set_token_owned(mint, data);
    }

    pub fn write_token_account(&mut self, owner: Pubkey, mint: Pubkey, amount: u64) {
        let a = spl_token::state::Account {
            mint,
            owner,
            amount,
            delegate: COption::None,
            state: spl_token::state::AccountState::Initialized,
            is_native: COption::None,
            delegated_amount: 0,
            close_authority: COption::None,
        };
        let mut data = vec![0u8; spl_token::state::Account::LEN];
        a.pack_into_slice(&mut data);
        self.set_token_owned(token_account_address(&owner, &mint), data);
    }

    fn set_token_owned(&mut self, address: Pubkey, data: Vec<u8>) {
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
        self.svm
            .set_account(address, Account { lamports, data, owner: spl_token::ID, executable: false, rent_epoch: 0 })
            .expect("token account");
    }

    /// Writes a Raydium CLMM pool account with token 0 the asset and token 1
    /// the pool's USDC, both six decimals, at `price` and `liquidity`.
    pub fn write_clmm(&mut self, address: Pubkey, price: u64, liquidity: u128) {
        let mut data = vec![0u8; 1544];
        data[..8].copy_from_slice(&unwind::amm::POOL_STATE_DISCRIMINATOR);
        let asset = find(&[b"asset", address.as_ref()], &MOCK_PYTH_ID);
        data[73..105].copy_from_slice(asset.as_ref());
        data[105..137].copy_from_slice(self.usdc_mint.as_ref());
        data[233] = 6;
        data[234] = 6;
        data[237..253].copy_from_slice(&liquidity.to_le_bytes());
        data[253..269].copy_from_slice(&sqrt_price_x64(price.max(1)).to_le_bytes());
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
        self.svm
            .set_account(
                address,
                Account { lamports, data, owner: unwind::amm::RAYDIUM_CLMM_ID, executable: false, rent_epoch: 0 },
            )
            .expect("clmm");
    }

    /// The liquidity a fake CLMM pool holds now.
    pub fn clmm_liquidity(&self, address: &Pubkey) -> u128 {
        let a = self.account(address).expect("clmm");
        u128::from_le_bytes(a.data[237..253].try_into().unwrap())
    }

    // ------------------------------------------------------------ time and prices

    pub fn clock(&self) -> Clock {
        self.svm.get_sysvar()
    }

    /// Moves the clock forward by `secs` seconds and `slots` slots.
    pub fn advance(&mut self, secs: i64, slots: u64) {
        let mut c = self.clock();
        c.unix_timestamp += secs;
        c.slot += slots;
        self.svm.set_sysvar(&c);
    }

    fn write_pyth(&mut self, address: Pubkey, feed_id: [u8; 32], price: u64) {
        let c = self.clock();
        let update = unwind::oracle::PriceUpdateV2 {
            write_authority: MOCK_PYTH_ID,
            verification_level: unwind::oracle::VerificationLevel::Full,
            price_message: unwind::oracle::PriceFeedMessage {
                feed_id,
                price: price as i64,
                conf: price * CONF_BPS / 10_000,
                exponent: -6,
                publish_time: c.unix_timestamp,
                prev_publish_time: c.unix_timestamp,
                ema_price: price as i64,
                ema_conf: price * CONF_BPS / 10_000,
            },
            posted_slot: c.slot,
        };
        let mut data = unwind::oracle::PRICE_UPDATE_V2_DISCRIMINATOR.to_vec();
        update.serialize(&mut data).unwrap();
        data.resize(8 + 32 + 2 + 84 + 8, 0);
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
        self.svm
            .set_account(address, Account { lamports, data, owner: MOCK_PYTH_ID, executable: false, rent_epoch: 0 })
            .expect("price");
    }

    /// Writes market `m`'s Pyth account at `price`, published now, and
    /// records it for every generation of the same feed. For an observed
    /// market this records the target and moves its fake pool there; the
    /// runner pushes or folds it.
    ///
    /// The pool moves for a keeper market as well as a folded one, because a
    /// pushed mark is checked against the pool in the same transaction. A
    /// keeper that priced a market somewhere its pool never went is a case
    /// the program now refuses, so driving it would only ever test the
    /// refusal.
    pub fn post_price(&mut self, m: usize, price: u64) {
        let fx = self.markets[m].clone();
        if fx.source == Source::Pyth {
            self.write_pyth(fx.price_account, fx.feed_id, price);
            for other in self.markets.iter_mut().filter(|o| o.price_account == fx.price_account) {
                other.price = price;
            }
        } else {
            self.markets[m].price = price;
            let liq = self.clmm_liquidity(&fx.amm);
            self.write_clmm(fx.amm, price, liq);
        }
    }

    pub fn post_custody_price(&mut self, i: usize, price: u64) {
        let c = self.custodies[i].clone();
        self.custodies[i].price = price;
        self.write_pyth(c.price_account, c.feed_id, price);
    }

    /// Reposts every Pyth market's and custody's current price at the
    /// current time, as the relay does every few seconds. Observed markets
    /// are the runner's to refresh: that takes transactions.
    pub fn repost_feeds(&mut self) {
        for m in 0..self.markets.len() {
            if self.markets[m].source == Source::Pyth {
                let p = self.markets[m].price;
                self.post_price(m, p);
            }
        }
        for i in 0..self.custodies.len() {
            let p = self.custodies[i].price;
            self.post_custody_price(i, p);
        }
    }

    /// The price market `m` is valued at now: the Pyth price, or the
    /// observation's mark.
    pub fn oracle_price(&self, m: usize) -> u64 {
        let fx = &self.markets[m];
        match fx.source {
            Source::Pyth => fx.price,
            _ => self.anchor::<Observation>(&fx.price_account).map_or(0, |o| o.ewma_price),
        }
    }

    // ------------------------------------------------------------ sending

    /// Sends `ix` signed by `signer`, under a raised compute limit.
    pub fn send(&mut self, (ix, signer): (Instruction, Keypair)) -> TxOutcome {
        let mut cu = vec![2u8];
        cu.extend_from_slice(&1_400_000u32.to_le_bytes());
        let budget = Instruction { program_id: COMPUTE_BUDGET_ID, accounts: vec![], data: cu };
        let msg = Message::new(&[budget, ix], Some(&signer.pubkey()));
        // Unsigned: the VM runs without signature checks, and signing is an
        // ed25519 operation per transaction the harness does not need. Each
        // signature slot gets a distinct filler so no two look the same.
        let mut tx = Transaction::new_unsigned(msg);
        let n = SENT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let mut sig = [0u8; 64];
        sig[..8].copy_from_slice(&n.to_le_bytes());
        tx.signatures = vec![sig.into(); tx.message.header.num_required_signatures as usize];
        let _ = &signer;
        match self.svm.send_transaction(tx) {
            Ok(meta) => {
                self.last_logs = meta.logs;
                TxOutcome::Ok
            }
            Err(f) => classify(&f.err, f.meta.logs),
        }
    }

    pub fn expect_ok(&mut self, ix: (Instruction, Keypair), what: &str) {
        match self.send(ix) {
            TxOutcome::Ok => {}
            other => panic!("bootstrap step {what} failed: {other:?}"),
        }
    }

    // ------------------------------------------------------------ reading

    pub fn account(&self, k: &Pubkey) -> Option<Account> {
        self.svm.get_account(k).filter(|a| a.lamports > 0 || !a.data.is_empty())
    }

    pub fn anchor<T: AccountDeserialize>(&self, k: &Pubkey) -> Option<T> {
        let a = self.account(k)?;
        if a.data.is_empty() {
            return None;
        }
        T::try_deserialize(&mut &a.data[..]).ok()
    }

    pub fn pool_state(&self) -> Pool {
        self.anchor(&self.pool).expect("pool")
    }

    pub fn market_state(&self, m: usize) -> Market {
        self.anchor(&self.markets[m].market).expect("market")
    }

    /// Market `m`'s batch, or an empty one for a market listed a moment ago
    /// whose batch is not open yet.
    pub fn batch_state(&self, m: usize) -> Batch {
        match self.account(&self.markets[m].batch) {
            Some(a) => bytemuck::pod_read_unaligned(&a.data[8..8 + std::mem::size_of::<Batch>()]),
            None => bytemuck::Zeroable::zeroed(),
        }
    }

    /// Overwrites market `m`'s batch: for the ordering checks only, which
    /// permute a clone's resting orders.
    pub fn write_batch(&mut self, m: usize, b: &Batch) {
        let addr = self.markets[m].batch;
        let mut a = self.account(&addr).expect("batch");
        a.data[8..8 + std::mem::size_of::<Batch>()].copy_from_slice(bytemuck::bytes_of(b));
        self.svm.set_account(addr, a).expect("batch");
    }

    pub fn position_address(&self, m: usize, owner: &Pubkey) -> Pubkey {
        pda(&[POSITION_SEED, self.markets[m].market.as_ref(), owner.as_ref()])
    }

    pub fn position_state(&self, m: usize, owner: &Pubkey) -> Option<Position> {
        self.anchor(&self.position_address(m, owner))
    }

    pub fn order_address(&self, t: usize, m: usize, slot: u8) -> Pubkey {
        let owner = self.traders[t].pubkey();
        pda(&[ORDER_SEED, self.markets[m].market.as_ref(), owner.as_ref(), &[slot]])
    }

    pub fn order_state(&self, t: usize, m: usize, slot: u8) -> Option<Order> {
        self.anchor(&self.order_address(t, m, slot))
    }

    pub fn trader_record(owner: &Pubkey) -> Pubkey {
        pda(&[TRADER_SEED, owner.as_ref()])
    }

    pub fn trader_state(&self, owner: &Pubkey) -> Option<Trader> {
        self.anchor(&Self::trader_record(owner))
    }

    pub fn custody_state(&self, i: usize) -> Custody {
        self.anchor(&self.custodies[i].custody).expect("custody")
    }

    pub fn book_address(&self, m: usize) -> Pubkey {
        pda(&[BACKING_BOOK_SEED, self.markets[m].market.as_ref()])
    }

    pub fn book_state(&self, m: usize) -> Option<unwind::state::BackingBook> {
        self.anchor(&self.book_address(m))
    }

    pub fn token_claim_address(&self, owner: &Pubkey) -> Pubkey {
        pda(&[LP_TOKEN_CLAIM_SEED, self.pool.as_ref(), owner.as_ref()])
    }

    pub fn token_balance(&self, address: &Pubkey) -> u64 {
        match self.account(address) {
            Some(a) if a.data.len() >= spl_token::state::Account::LEN => {
                spl_token::state::Account::unpack_from_slice(&a.data).map(|t| t.amount).unwrap_or(0)
            }
            _ => 0,
        }
    }

    pub fn mint_supply(&self, mint: &Pubkey) -> u64 {
        let a = self.account(mint).expect("mint");
        spl_token::state::Mint::unpack_from_slice(&a.data).expect("mint").supply
    }

    pub fn usdc_of(&self, owner: &Pubkey) -> u64 {
        self.token_balance(&token_account_address(owner, &self.usdc_mint))
    }

    pub fn lp_of(&self, owner: &Pubkey) -> u64 {
        self.token_balance(&token_account_address(owner, &self.lp_mint))
    }

    /// Every wallet the harness funds: the authority, traders, LPs, backers.
    pub fn owners(&self) -> Vec<Pubkey> {
        std::iter::once(self.authority.pubkey())
            .chain(self.traders.iter().map(|k| k.pubkey()))
            .chain(self.lps.iter().map(|k| k.pubkey()))
            .chain(self.backers.iter().map(|k| k.pubkey()))
            .collect()
    }

    pub fn withdraw_request(&self, owner: &Pubkey) -> Pubkey {
        pda(&[WITHDRAW_REQUEST_SEED, self.pool.as_ref(), owner.as_ref()])
    }

    pub fn withdraw_escrow(&self, owner: &Pubkey) -> Pubkey {
        pda(&[WITHDRAW_ESCROW_SEED, self.withdraw_request(owner).as_ref()])
    }

    pub fn backing_shares(&self, backer: usize, m: usize) -> u64 {
        let k = self.backers[backer].pubkey();
        let addr = pda(&[BACKING_SEED, self.markets[m].market.as_ref(), k.as_ref()]);
        self.anchor::<unwind::instructions::Backing>(&addr).map_or(0, |b| b.shares)
    }

    /// `(market, price_update)` pairs, in increasing market address order, of
    /// the markets carrying open interest: what a checkpoint pass counts.
    pub fn oi_pairs(&self) -> Vec<AccountMeta> {
        let mut ms: Vec<&MarketFx> = (0..self.markets.len())
            .filter(|&m| self.market_state(m).has_open_interest())
            .map(|m| &self.markets[m])
            .collect();
        ms.sort_by_key(|fx| fx.market);
        ms.iter()
            .flat_map(|fx| {
                [AccountMeta::new_readonly(fx.market, false), AccountMeta::new_readonly(fx.price_account, false)]
            })
            .collect()
    }

    /// `(custody, price_update)` for every custody, in index order.
    fn custody_pairs(&self) -> Vec<AccountMeta> {
        self.custodies
            .iter()
            .flat_map(|c| [AccountMeta::new(c.custody, false), AccountMeta::new_readonly(c.price_account, false)])
            .collect()
    }

    // ------------------------------------------------------------ instructions

    fn ix<A: ToAccountMetas, D: InstructionData>(accounts: A, data: D) -> Instruction {
        Instruction { program_id: unwind::ID, accounts: accounts.to_account_metas(None), data: data.data() }
    }

    fn checkpoint(&self) -> Pubkey {
        pda(&[AUM_SEED, self.pool.as_ref()])
    }

    fn mark_keeper(&self) -> Pubkey {
        pda(&[MARK_KEEPER_SEED, self.pool.as_ref()])
    }

    fn programdata() -> Pubkey {
        find(&[unwind::ID.as_ref()], &bpf_loader_upgradeable::ID)
    }

    fn auth(&self) -> Keypair {
        self.authority.insecure_clone()
    }

    pub fn ix_initialize_pool(&self) -> (Instruction, Keypair) {
        let a = &self.authority;
        let accounts = unwind::accounts::InitializePool {
            authority: a.pubkey(),
            pool: self.pool,
            usdc_mint: self.usdc_mint,
            usdc_vault: self.vault,
            lp_mint: self.lp_mint,
            token_program: spl_token::ID,
            system_program: anchor_lang::system_program::ID,
            rent: anchor_lang::solana_program::sysvar::rent::ID,
            program_data: Self::programdata(),
        };
        let params = unwind::instructions::PoolParams {
            pyth_receiver: MOCK_PYTH_ID,
            chain_fee_destination: a.pubkey(),
            add_liquidity_fee_bps: 0,
            remove_liquidity_fee_bps: 5,
            protocol_fee_share_bps: 2_000,
            insurance_fee_share_bps: 1_000,
            max_utilization_bps: 8_000,
        };
        (Self::ix(accounts, unwind::instruction::InitializePool { params }), a.insecure_clone())
    }

    /// The parameters market `m` lists with. A lister other than the
    /// authority gets the permissionless bounds.
    pub fn market_params(&self, m: usize, spec: Spec, permissionless: bool) -> unwind::instructions::MarketParams {
        let fx = &self.markets[m];
        let mut sym = [0u8; 16];
        sym[..spec.symbol.len()].copy_from_slice(spec.symbol.as_bytes());
        let observed = spec.source != Source::Pyth;
        let mut p = unwind::instructions::MarketParams {
            symbol: sym,
            feed_id: fx.feed_id,
            max_price_age_sec: 60,
            max_conf_bps: 200,
            max_leverage_bps: spec.max_leverage_bps,
            maintenance_margin_bps: spec.mm_bps,
            liquidation_fee_bps: 100,
            open_fee_bps: 6,
            close_fee_bps: 6,
            min_position_usd: 10 * USD,
            max_oi_long_usd: 2_000_000 * USD,
            max_oi_short_usd: 2_000_000 * USD,
            pnl_reserve_bps: 10_000,
            base_spread_bps: 4,
            conf_spread_mult_bps: 10_000,
            max_spread_bps: 500,
            closed_session_leverage_bps: 20_000,
            closed_session_oi_mult_bps: 2_500,
            max_funding_rate_bps_per_hour: 100,
            funding_k_bps: 8_000,
            borrow_rate_bps_per_hour: 1,
            price_source: observed as u8,
            observation: if observed { fx.price_account } else { Pubkey::default() },
        };
        if permissionless {
            p.max_leverage_bps = p.max_leverage_bps.min(50_000);
            p.maintenance_margin_bps = p.maintenance_margin_bps.max(500);
            p.closed_session_leverage_bps = p.closed_session_leverage_bps.min(p.max_leverage_bps);
            p.max_oi_long_usd = 50_000 * USD;
            p.max_oi_short_usd = 50_000 * USD;
            p.open_fee_bps = 10;
            p.close_fee_bps = 10;
            p.base_spread_bps = 10;
        }
        p
    }

    fn ix_add_market(&self, m: usize, spec: Spec, lister: Option<usize>) -> (Instruction, Keypair) {
        let fx = &self.markets[m];
        let payer = match lister {
            Some(t) => self.traders[t].insecure_clone(),
            None => self.auth(),
        };
        let params = self.market_params(m, spec, lister.is_some());
        let accounts = unwind::accounts::AddMarket {
            payer: payer.pubkey(),
            pool: self.pool,
            generations: pda(&[MARKET_GENERATION_SEED, self.pool.as_ref(), &fx.feed_id]),
            market: fx.market,
            system_program: anchor_lang::system_program::ID,
        };
        (Self::ix(accounts, unwind::instruction::AddMarket { params, generation: fx.generation }), payer)
    }

    pub fn ix_create_batch(&self, m: usize) -> (Instruction, Keypair) {
        let fx = &self.markets[m];
        let accounts = unwind::accounts::CreateBatch {
            payer: self.authority.pubkey(),
            pool: self.pool,
            market: fx.market,
            batch: fx.batch,
            system_program: anchor_lang::system_program::ID,
        };
        (Self::ix(accounts, unwind::instruction::CreateBatch {}), self.auth())
    }

    pub fn ix_update_market(&self, m: usize, params: unwind::instructions::MarketParams) -> (Instruction, Keypair) {
        (Self::ix(self.update_accounts(m), unwind::instruction::UpdateMarketParams { params }), self.auth())
    }

    fn update_accounts(&self, m: usize) -> unwind::accounts::UpdateMarket {
        unwind::accounts::UpdateMarket { authority: self.authority.pubkey(), pool: self.pool, market: self.markets[m].market }
    }

    pub fn ix_set_session(&self, m: usize, session: u8) -> (Instruction, Keypair) {
        (Self::ix(self.update_accounts(m), unwind::instruction::SetSession { session }), self.auth())
    }

    pub fn ix_set_market_budget(&self, m: usize, loss_budget_usd: u64) -> (Instruction, Keypair) {
        (Self::ix(self.update_accounts(m), unwind::instruction::SetMarketBudget { loss_budget_usd }), self.auth())
    }

    pub fn ix_set_market_paused(&self, m: usize, paused: bool) -> (Instruction, Keypair) {
        (Self::ix(self.update_accounts(m), unwind::instruction::SetMarketPaused { paused }), self.auth())
    }

    pub fn ix_corporate_action(&self, m: usize, numerator: u64, denominator: u64) -> (Instruction, Keypair) {
        let fx = &self.markets[m];
        let accounts = unwind::accounts::CorporateAction {
            authority: self.authority.pubkey(),
            pool: self.pool,
            market: fx.market,
            batch: fx.batch,
            observation: (fx.source != Source::Pyth).then_some(fx.price_account),
        };
        let data = unwind::instruction::ApplyCorporateAction {
            numerator,
            denominator,
            new_multiplier: unwind::constants::MULTIPLIER_SCALE as u64,
        };
        (Self::ix(accounts, data), self.auth())
    }

    pub fn ix_set_pool_paused(&self, paused: bool) -> (Instruction, Keypair) {
        let accounts = unwind::accounts::UpdatePool { authority: self.authority.pubkey(), pool: self.pool };
        (Self::ix(accounts, unwind::instruction::SetPoolPaused { paused }), self.auth())
    }

    pub fn ix_set_pool_points(&self, enabled: bool) -> (Instruction, Keypair) {
        let accounts = unwind::accounts::SetPoolPoints {
            upgrade_authority: self.authority.pubkey(),
            pool: self.pool,
            program_data: Self::programdata(),
        };
        (Self::ix(accounts, unwind::instruction::SetPoolPoints { enabled }), self.auth())
    }

    /// Nominated by `from`, the current authority.
    pub fn ix_nominate_authority(&self, from: &Keypair, new_authority: Pubkey) -> (Instruction, Keypair) {
        let accounts = unwind::accounts::UpdatePool { authority: from.pubkey(), pool: self.pool };
        (Self::ix(accounts, unwind::instruction::NominateAuthority { new_authority }), from.insecure_clone())
    }

    pub fn ix_accept_authority(&self, by: &Keypair) -> (Instruction, Keypair) {
        let accounts = unwind::accounts::AcceptAuthority { new_authority: by.pubkey(), pool: self.pool };
        (Self::ix(accounts, unwind::instruction::AcceptAuthority {}), by.insecure_clone())
    }

    pub fn ix_resize_market(&self, m: usize) -> (Instruction, Keypair) {
        let accounts = unwind::accounts::ResizeMarket {
            payer: self.authority.pubkey(),
            market: self.markets[m].market,
            system_program: anchor_lang::system_program::ID,
        };
        (Self::ix(accounts, unwind::instruction::ResizeMarket {}), self.auth())
    }

    pub fn ix_resize_pool(&self) -> (Instruction, Keypair) {
        let accounts = unwind::accounts::ResizePool {
            payer: self.authority.pubkey(),
            pool: self.pool,
            system_program: anchor_lang::system_program::ID,
        };
        (Self::ix(accounts, unwind::instruction::ResizePool {}), self.auth())
    }

    pub fn ix_resize_trader(&self, owner: &Pubkey) -> (Instruction, Keypair) {
        let accounts = unwind::accounts::ResizeTrader {
            payer: self.authority.pubkey(),
            trader: Self::trader_record(owner),
            system_program: anchor_lang::system_program::ID,
        };
        (Self::ix(accounts, unwind::instruction::ResizeTrader {}), self.auth())
    }

    fn ix_add_custody(&self, i: usize) -> (Instruction, Keypair) {
        let c = &self.custodies[i];
        let accounts = unwind::accounts::AddCustody {
            authority: self.authority.pubkey(),
            pool: self.pool,
            mint: c.mint,
            custody: c.custody,
            vault: c.vault,
            token_program: spl_token::ID,
            system_program: anchor_lang::system_program::ID,
        };
        let params = unwind::instructions::CustodyParams {
            is_stable: c.stable,
            feed_id: c.feed_id,
            max_price_age_sec: 60,
            max_conf_bps: 200,
            budget_weight_bps: if c.stable { 10_000 } else { 8_000 },
        };
        (Self::ix(accounts, unwind::instruction::AddCustody { params }), self.auth())
    }

    // --- observed markets

    pub fn ix_set_mark_keeper(&self, keeper: Pubkey) -> (Instruction, Keypair) {
        let accounts = unwind::accounts::SetMarkKeeper {
            authority: self.authority.pubkey(),
            pool: self.pool,
            mark_keeper: self.mark_keeper(),
            system_program: anchor_lang::system_program::ID,
        };
        (Self::ix(accounts, unwind::instruction::SetMarkKeeper { keeper }), self.auth())
    }

    pub fn ix_create_observation(&self, m: usize) -> (Instruction, Keypair) {
        let fx = &self.markets[m];
        let accounts = unwind::accounts::CreateObservation {
            payer: self.authority.pubkey(),
            pool: self.pool,
            market: fx.market,
            observation: fx.price_account,
            source: fx.amm,
            system_program: anchor_lang::system_program::ID,
        };
        let params = unwind::instructions::ObservationParams {
            source: fx.amm,
            source_kind: 0,
            quote_is_token_0: false,
            alpha_bps: 1_000,
            max_move_bps: 100,
            unit_exp: 0,
        };
        (Self::ix(accounts, unwind::instruction::CreateObservation { params }), self.auth())
    }

    pub fn ix_push_mark(&self, m: usize, price: u64) -> (Instruction, Keypair) {
        let fx = &self.markets[m];
        let accounts = unwind::accounts::PushMark {
            keeper: self.authority.pubkey(),
            observation: fx.price_account,
            market: fx.market,
            mark_keeper: self.mark_keeper(),
            source: fx.amm,
        };
        (Self::ix(accounts, unwind::instruction::PushMark { price }), self.auth())
    }

    pub fn ix_observe(&self, m: usize) -> (Instruction, Keypair) {
        let fx = &self.markets[m];
        let accounts =
            unwind::accounts::Observe { observation: fx.price_account, market: fx.market, source: fx.amm };
        (Self::ix(accounts, unwind::instruction::Observe {}), self.auth())
    }

    pub fn ix_derive_budget(&self, m: usize) -> (Instruction, Keypair) {
        let fx = &self.markets[m];
        let accounts =
            unwind::accounts::DeriveBudget { pool: self.pool, market: fx.market, observation: fx.price_account };
        (Self::ix(accounts, unwind::instruction::DeriveMarketBudget {}), self.auth())
    }

    // --- backing

    /// `asset` 0 is USDC, `1 + i` custody `i`; `amount` in its base units.
    pub fn ix_back_market(&self, backer: usize, m: usize, asset: usize, amount: u64) -> (Instruction, Keypair) {
        let k = &self.backers[backer];
        let fx = &self.markets[m];
        let (mint, vault) = match asset {
            0 => (self.usdc_mint, self.vault),
            a => (self.custodies[a - 1].mint, self.custodies[a - 1].vault),
        };
        let accounts = unwind::accounts::BackMarket {
            owner: k.pubkey(),
            pool: self.pool,
            market: fx.market,
            backing: pda(&[BACKING_SEED, fx.market.as_ref(), k.pubkey().as_ref()]),
            book: self.book_address(m),
            deposit_mint: mint,
            deposit_vault: vault,
            owner_token: token_account_address(&k.pubkey(), &mint),
            trader: Self::trader_record(&k.pubkey()),
            token_program: spl_token::ID,
            system_program: anchor_lang::system_program::ID,
        };
        let mut ix = Self::ix(accounts, unwind::instruction::BackMarket { amount });
        ix.accounts.extend(self.custody_pairs());
        (ix, k.insecure_clone())
    }

    pub fn ix_unback_market(&self, backer: usize, m: usize, shares: u64) -> (Instruction, Keypair) {
        let k = &self.backers[backer];
        let fx = &self.markets[m];
        let accounts = unwind::accounts::UnbackMarket {
            owner: k.pubkey(),
            pool: self.pool,
            market: fx.market,
            price_update: fx.price_account,
            backing: pda(&[BACKING_SEED, fx.market.as_ref(), k.pubkey().as_ref()]),
            book: self.book_address(m),
            usdc_mint: self.usdc_mint,
            usdc_vault: self.vault,
            owner_usdc: token_account_address(&k.pubkey(), &self.usdc_mint),
            trader: Self::trader_record(&k.pubkey()),
            token_program: spl_token::ID,
            system_program: anchor_lang::system_program::ID,
        };
        let mut ix = Self::ix(accounts, unwind::instruction::UnbackMarket { shares });
        ix.accounts.extend(self.custody_pairs());
        for c in &self.custodies {
            ix.accounts.push(AccountMeta::new_readonly(c.mint, false));
            ix.accounts.push(AccountMeta::new(c.vault, false));
            ix.accounts.push(AccountMeta::new(token_account_address(&k.pubkey(), &c.mint), false));
        }
        (ix, k.insecure_clone())
    }

    pub fn ix_sync_backing(&self, m: usize) -> (Instruction, Keypair) {
        let accounts =
            unwind::accounts::SyncBacking { pool: self.pool, market: self.markets[m].market, book: self.book_address(m) };
        let mut ix = Self::ix(accounts, unwind::instruction::SyncBacking {});
        ix.accounts.extend(self.custody_pairs());
        (ix, self.auth())
    }

    pub fn ix_mark_backing(&self, backer: usize, m: usize) -> (Instruction, Keypair) {
        let k = self.backers[backer].pubkey();
        let fx = &self.markets[m];
        let accounts = unwind::accounts::MarkBacking {
            pool: self.pool,
            market: fx.market,
            book: Some(self.book_address(m)),
            backing: pda(&[BACKING_SEED, fx.market.as_ref(), k.as_ref()]),
            trader: Self::trader_record(&k),
        };
        let mut ix = Self::ix(accounts, unwind::instruction::MarkBacking {});
        ix.accounts.extend(self.custody_pairs());
        (ix, self.auth())
    }

    // --- liquidity

    pub fn ix_checkpoint_aum(&self, restart: bool, pairs: &[AccountMeta]) -> (Instruction, Keypair) {
        let accounts = unwind::accounts::CheckpointAum {
            payer: self.authority.pubkey(),
            pool: self.pool,
            checkpoint: self.checkpoint(),
            system_program: anchor_lang::system_program::ID,
        };
        let mut ix = Self::ix(accounts, unwind::instruction::CheckpointAum { restart });
        ix.accounts.extend_from_slice(pairs);
        (ix, self.auth())
    }

    pub fn ix_add_liquidity(&self, lp: usize, amount: u64) -> (Instruction, Keypair) {
        let k = &self.lps[lp];
        let accounts = unwind::accounts::ManageLiquidity {
            owner: k.pubkey(),
            pool: self.pool,
            usdc_mint: self.usdc_mint,
            usdc_vault: self.vault,
            lp_mint: self.lp_mint,
            owner_usdc: token_account_address(&k.pubkey(), &self.usdc_mint),
            owner_lp: token_account_address(&k.pubkey(), &self.lp_mint),
            trader: Self::trader_record(&k.pubkey()),
            checkpoint: self.checkpoint(),
            token_program: spl_token::ID,
            system_program: anchor_lang::system_program::ID,
        };
        let mut ix = Self::ix(accounts, unwind::instruction::AddLiquidity { amount_usd: amount, min_lp_out: 0 });
        ix.accounts.extend(self.custody_pairs());
        (ix, k.insecure_clone())
    }

    pub fn ix_request_withdraw(&self, lp: usize, lp_amount: u64) -> (Instruction, Keypair) {
        let k = &self.lps[lp];
        let accounts = unwind::accounts::RequestWithdraw {
            owner: k.pubkey(),
            pool: self.pool,
            lp_mint: self.lp_mint,
            owner_lp: token_account_address(&k.pubkey(), &self.lp_mint),
            request: self.withdraw_request(&k.pubkey()),
            escrow_lp: self.withdraw_escrow(&k.pubkey()),
            trader: Self::trader_record(&k.pubkey()),
            token_program: spl_token::ID,
            system_program: anchor_lang::system_program::ID,
        };
        (Self::ix(accounts, unwind::instruction::RequestWithdraw { lp_amount }), k.insecure_clone())
    }

    pub fn ix_cancel_withdraw(&self, lp: usize) -> (Instruction, Keypair) {
        let k = &self.lps[lp];
        let accounts = unwind::accounts::CancelWithdraw {
            owner: k.pubkey(),
            pool: self.pool,
            lp_mint: self.lp_mint,
            owner_lp: token_account_address(&k.pubkey(), &self.lp_mint),
            request: self.withdraw_request(&k.pubkey()),
            escrow_lp: self.withdraw_escrow(&k.pubkey()),
            trader: Self::trader_record(&k.pubkey()),
            token_program: spl_token::ID,
        };
        (Self::ix(accounts, unwind::instruction::CancelWithdraw {}), k.insecure_clone())
    }

    pub fn ix_claim_withdraw(&self, lp: usize, lp_amount: u64) -> (Instruction, Keypair) {
        let k = &self.lps[lp];
        let accounts = unwind::accounts::ClaimWithdraw {
            owner: k.pubkey(),
            pool: self.pool,
            usdc_mint: self.usdc_mint,
            usdc_vault: self.vault,
            lp_mint: self.lp_mint,
            owner_usdc: token_account_address(&k.pubkey(), &self.usdc_mint),
            request: self.withdraw_request(&k.pubkey()),
            escrow_lp: self.withdraw_escrow(&k.pubkey()),
            checkpoint: self.checkpoint(),
            token_claim: self.token_claim_address(&k.pubkey()),
            token_program: spl_token::ID,
            system_program: anchor_lang::system_program::ID,
        };
        let mut ix =
            Self::ix(accounts, unwind::instruction::ClaimWithdraw { lp_amount, min_usd_out: 0 });
        ix.accounts.extend(self.custody_pairs());
        (ix, k.insecure_clone())
    }

    pub fn ix_claim_withdraw_tokens(&self, lp: usize, i: usize) -> (Instruction, Keypair) {
        let k = &self.lps[lp];
        let c = &self.custodies[i];
        let accounts = unwind::accounts::ClaimWithdrawTokens {
            owner: k.pubkey(),
            pool: self.pool,
            custody: c.custody,
            mint: c.mint,
            vault: c.vault,
            owner_token: token_account_address(&k.pubkey(), &c.mint),
            token_claim: self.token_claim_address(&k.pubkey()),
            token_program: spl_token::ID,
        };
        (Self::ix(accounts, unwind::instruction::ClaimWithdrawTokens {}), k.insecure_clone())
    }

    // --- trading

    #[allow(clippy::too_many_arguments)]
    pub fn ix_submit_order(
        &self,
        trader: usize,
        m: usize,
        price: u64,
        size_usd: u64,
        collateral_usd: u64,
        is_bid: bool,
        reduce_only: bool,
        is_maker: bool,
    ) -> (Instruction, Keypair) {
        let k = &self.traders[trader];
        let fx = &self.markets[m];
        let accounts = unwind::accounts::SubmitOrder {
            owner: k.pubkey(),
            pool: self.pool,
            market: fx.market,
            batch: fx.batch,
            usdc_mint: self.usdc_mint,
            usdc_vault: self.vault,
            owner_usdc: token_account_address(&k.pubkey(), &self.usdc_mint),
            position: self.position_address(m, &k.pubkey()),
            trader: Self::trader_record(&k.pubkey()),
            token_program: spl_token::ID,
            system_program: anchor_lang::system_program::ID,
        };
        let data = unwind::instruction::SubmitOrder {
            price,
            size_usd,
            collateral_usd,
            is_bid,
            reduce_only,
            is_maker,
        };
        (Self::ix(accounts, data), k.insecure_clone())
    }

    pub fn ix_cancel_batch_order(&self, trader: usize, m: usize, index: u8) -> (Instruction, Keypair) {
        let k = &self.traders[trader];
        let fx = &self.markets[m];
        let accounts = unwind::accounts::CancelBatchOrder {
            owner: k.pubkey(),
            pool: self.pool,
            market: fx.market,
            batch: fx.batch,
            usdc_mint: self.usdc_mint,
            usdc_vault: self.vault,
            owner_usdc: token_account_address(&k.pubkey(), &self.usdc_mint),
            position: self.position_address(m, &k.pubkey()),
            token_program: spl_token::ID,
        };
        (Self::ix(accounts, unwind::instruction::CancelBatchOrder { index }), k.insecure_clone())
    }

    pub fn ix_clear_batch(&self, m: usize) -> (Instruction, Keypair) {
        let fx = &self.markets[m];
        let accounts = unwind::accounts::ClearBatch {
            pool: self.pool,
            market: fx.market,
            batch: fx.batch,
            price_update: fx.price_account,
        };
        (Self::ix(accounts, unwind::instruction::ClearBatch {}), self.auth())
    }

    pub fn ix_settle_order(&self, m: usize, index: u8, owner: Pubkey) -> (Instruction, Keypair) {
        let fx = &self.markets[m];
        let accounts = unwind::accounts::SettleOrder {
            pool: self.pool,
            market: fx.market,
            batch: fx.batch,
            owner,
            position: self.position_address(m, &owner),
            usdc_mint: self.usdc_mint,
            usdc_vault: self.vault,
            owner_usdc: token_account_address(&owner, &self.usdc_mint),
            trader: Self::trader_record(&owner),
            token_program: spl_token::ID,
        };
        (Self::ix(accounts, unwind::instruction::SettleOrder { index }), self.auth())
    }

    pub fn ix_accrue_funding(&self, m: usize) -> (Instruction, Keypair) {
        let accounts = unwind::accounts::AccrueFunding { pool: self.pool, market: self.markets[m].market };
        (Self::ix(accounts, unwind::instruction::AccrueFunding {}), self.auth())
    }

    pub fn ix_step_risk_price(&self, m: usize) -> (Instruction, Keypair) {
        let fx = &self.markets[m];
        let accounts = unwind::accounts::StepRiskPrice {
            pool: self.pool,
            market: fx.market,
            price_update: fx.price_account,
        };
        (Self::ix(accounts, unwind::instruction::StepRiskPrice {}), self.auth())
    }

    /// Liquidates `owner`'s position in market `m`; the authority is the
    /// liquidator and is paid the bounty.
    pub fn ix_liquidate(&self, m: usize, owner: Pubkey) -> (Instruction, Keypair) {
        let fx = &self.markets[m];
        let accounts = unwind::accounts::Liquidate {
            liquidator: self.authority.pubkey(),
            pool: self.pool,
            market: fx.market,
            position: self.position_address(m, &owner),
            owner,
            price_update: fx.price_account,
            usdc_mint: self.usdc_mint,
            usdc_vault: self.vault,
            owner_usdc: token_account_address(&owner, &self.usdc_mint),
            liquidator_usdc: token_account_address(&self.authority.pubkey(), &self.usdc_mint),
            token_program: spl_token::ID,
        };
        (Self::ix(accounts, unwind::instruction::Liquidate {}), self.auth())
    }

    pub fn ix_auto_deleverage(&self, m: usize, owner: Pubkey) -> (Instruction, Keypair) {
        let fx = &self.markets[m];
        let accounts = unwind::accounts::AutoDeleverage {
            keeper: self.authority.pubkey(),
            pool: self.pool,
            market: fx.market,
            position: self.position_address(m, &owner),
            owner,
            price_update: fx.price_account,
            usdc_mint: self.usdc_mint,
            usdc_vault: self.vault,
            owner_usdc: token_account_address(&owner, &self.usdc_mint),
            token_program: spl_token::ID,
        };
        (Self::ix(accounts, unwind::instruction::AutoDeleverage {}), self.auth())
    }

    // --- trigger orders

    pub fn ix_place_order(
        &self,
        t: usize,
        m: usize,
        params: unwind::instructions::OrderParams,
    ) -> (Instruction, Keypair) {
        let k = &self.traders[t];
        let fx = &self.markets[m];
        let accounts = unwind::accounts::PlaceOrder {
            owner: k.pubkey(),
            pool: self.pool,
            market: fx.market,
            order: self.order_address(t, m, params.slot),
            position: self.position_address(m, &k.pubkey()),
            usdc_mint: self.usdc_mint,
            usdc_vault: self.vault,
            owner_usdc: token_account_address(&k.pubkey(), &self.usdc_mint),
            token_program: spl_token::ID,
            system_program: anchor_lang::system_program::ID,
        };
        (Self::ix(accounts, unwind::instruction::PlaceOrder { params }), k.insecure_clone())
    }

    pub fn ix_cancel_order(&self, t: usize, m: usize, slot: u8) -> (Instruction, Keypair) {
        let k = &self.traders[t];
        let fx = &self.markets[m];
        let accounts = unwind::accounts::CancelOrder {
            owner: k.pubkey(),
            pool: self.pool,
            market: fx.market,
            order: self.order_address(t, m, slot),
            usdc_mint: self.usdc_mint,
            usdc_vault: self.vault,
            owner_usdc: token_account_address(&k.pubkey(), &self.usdc_mint),
            token_program: spl_token::ID,
        };
        (Self::ix(accounts, unwind::instruction::CancelOrder {}), k.insecure_clone())
    }

    /// Fired by the authority as keeper.
    pub fn ix_execute_order(&self, t: usize, m: usize, slot: u8) -> (Instruction, Keypair) {
        let owner = self.traders[t].pubkey();
        let fx = &self.markets[m];
        let accounts = unwind::accounts::ExecuteOrder {
            keeper: self.authority.pubkey(),
            pool: self.pool,
            market: fx.market,
            order: self.order_address(t, m, slot),
            position: self.position_address(m, &owner),
            owner,
            price_update: fx.price_account,
            batch: fx.batch,
            usdc_mint: self.usdc_mint,
            usdc_vault: self.vault,
            owner_usdc: token_account_address(&owner, &self.usdc_mint),
            token_program: spl_token::ID,
        };
        (Self::ix(accounts, unwind::instruction::ExecuteOrder {}), self.auth())
    }

    // --- fees and insurance

    pub fn ix_collect_protocol_fees(&self, amount: u64) -> (Instruction, Keypair) {
        let accounts = unwind::accounts::CollectProtocolFees {
            authority: self.authority.pubkey(),
            pool: self.pool,
            usdc_mint: self.usdc_mint,
            usdc_vault: self.vault,
            destination: token_account_address(&self.authority.pubkey(), &self.usdc_mint),
            token_program: spl_token::ID,
        };
        (Self::ix(accounts, unwind::instruction::CollectProtocolFees { amount }), self.auth())
    }

    pub fn ix_collect_chain_fees(&self) -> (Instruction, Keypair) {
        let accounts = unwind::accounts::CollectChainFees {
            pool: self.pool,
            usdc_mint: self.usdc_mint,
            usdc_vault: self.vault,
            destination_usdc: token_account_address(&self.authority.pubkey(), &self.usdc_mint),
            token_program: spl_token::ID,
        };
        (Self::ix(accounts, unwind::instruction::CollectChainFees {}), self.backers[0].insecure_clone())
    }

    pub fn ix_fund_insurance(&self, backer: usize, amount: u64) -> (Instruction, Keypair) {
        let k = &self.backers[backer];
        let accounts = unwind::accounts::FundInsurance {
            payer: k.pubkey(),
            pool: self.pool,
            usdc_mint: self.usdc_mint,
            usdc_vault: self.vault,
            payer_usdc: token_account_address(&k.pubkey(), &self.usdc_mint),
            token_program: spl_token::ID,
        };
        (Self::ix(accounts, unwind::instruction::FundInsurance { amount }), k.insecure_clone())
    }

    // --- referrals and points

    /// A wallet the harness funds, by index into `owners()`.
    pub fn owner_key(&self, who: usize) -> Keypair {
        let all: Vec<&Keypair> = std::iter::once(&self.authority)
            .chain(&self.traders)
            .chain(&self.lps)
            .chain(&self.backers)
            .collect();
        all[who % all.len()].insecure_clone()
    }

    pub fn ix_create_trader(&self, k: &Keypair) -> (Instruction, Keypair) {
        let accounts = unwind::accounts::CreateTrader {
            owner: k.pubkey(),
            trader: Self::trader_record(&k.pubkey()),
            system_program: anchor_lang::system_program::ID,
        };
        (Self::ix(accounts, unwind::instruction::CreateTrader {}), k.insecure_clone())
    }

    pub fn ix_claim_referral_code(&self, k: &Keypair, code: [u8; REFERRAL_CODE_LEN]) -> (Instruction, Keypair) {
        let accounts = unwind::accounts::ClaimReferralCode {
            owner: k.pubkey(),
            trader: Self::trader_record(&k.pubkey()),
            referral_code: pda(&[REFERRAL_CODE_SEED, code.as_ref()]),
            system_program: anchor_lang::system_program::ID,
        };
        (Self::ix(accounts, unwind::instruction::ClaimReferralCode { code }), k.insecure_clone())
    }

    /// `referrer` is the code's holder, which the harness knows.
    pub fn ix_set_referrer(&self, k: &Keypair, code: [u8; REFERRAL_CODE_LEN], referrer: Pubkey) -> (Instruction, Keypair) {
        let accounts = unwind::accounts::SetReferrer {
            owner: k.pubkey(),
            trader: Self::trader_record(&k.pubkey()),
            referral_code: pda(&[REFERRAL_CODE_SEED, code.as_ref()]),
            referrer_trader: Self::trader_record(&referrer),
            system_program: anchor_lang::system_program::ID,
        };
        (Self::ix(accounts, unwind::instruction::SetReferrer { code }), k.insecure_clone())
    }

    pub fn ix_sync_referral(&self, referee: &Pubkey, referrer: &Pubkey) -> (Instruction, Keypair) {
        let accounts = unwind::accounts::SyncReferral {
            referee: Self::trader_record(referee),
            referrer: Self::trader_record(referrer),
        };
        (Self::ix(accounts, unwind::instruction::SyncReferral {}), self.backers[1].insecure_clone())
    }

    pub fn ix_sync_deployer(&self, m: usize, deployer: &Pubkey) -> (Instruction, Keypair) {
        let accounts = unwind::accounts::SyncDeployer {
            market: self.markets[m].market,
            deployer: Self::trader_record(deployer),
        };
        (Self::ix(accounts, unwind::instruction::SyncDeployer {}), self.backers[1].insecure_clone())
    }

    pub fn ix_claim_rewards(&self, k: &Keypair) -> (Instruction, Keypair) {
        let accounts = unwind::accounts::ClaimRewards {
            owner: k.pubkey(),
            pool: self.pool,
            trader: Self::trader_record(&k.pubkey()),
            usdc_mint: self.usdc_mint,
            usdc_vault: self.vault,
            owner_usdc: token_account_address(&k.pubkey(), &self.usdc_mint),
            token_program: spl_token::ID,
        };
        (Self::ix(accounts, unwind::instruction::ClaimRewards {}), k.insecure_clone())
    }

    pub fn ix_accrue_points(&self, k: &Keypair, show_lp: bool) -> (Instruction, Keypair) {
        let accounts = unwind::accounts::AccruePoints {
            owner: k.pubkey(),
            trader: Self::trader_record(&k.pubkey()),
            pool: self.pool,
            owner_lp: show_lp.then(|| token_account_address(&k.pubkey(), &self.lp_mint)),
        };
        (Self::ix(accounts, unwind::instruction::AccruePoints {}), k.insecure_clone())
    }
}

/// Sorts a failed transaction into a refusal or an abort.
///
/// A custom error is the program saying no, which is fine. A panic, an
/// arithmetic overflow trap or running out of compute is not a refusal: it
/// is the program failing to decide, and in a permissionless settlement or
/// crank that leaves a market stuck.
fn classify(err: &TransactionError, logs: Vec<String>) -> TxOutcome {
    let panicked = logs.iter().any(|l| l.contains("panicked") || l.contains("Program failed to complete"));
    match err {
        _ if panicked => TxOutcome::Aborted { reason: format!("{err:?}"), logs },
        TransactionError::InstructionError(_, InstructionError::Custom(code)) => {
            TxOutcome::Rejected { name: error_name(*code) }
        }
        TransactionError::InstructionError(_, InstructionError::ComputationalBudgetExceeded)
        | TransactionError::InstructionError(_, InstructionError::ProgramFailedToComplete) => {
            TxOutcome::Aborted { reason: format!("{err:?}"), logs }
        }
        other => TxOutcome::Rejected { name: format!("{other:?}") },
    }
}
