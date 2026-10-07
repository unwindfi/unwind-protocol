//! The world the stateful fuzz harness drives: the real compiled `unwind` and
//! `mock_pyth` programs loaded into litesvm, a pool bootstrapped the way
//! `scripts/bootstrap-localnet.ts` does it, and one builder per instruction.
//!
//! Everything here is plumbing. It decides nothing about what is correct;
//! that lives with the invariants in `stateful_fuzz.rs`.
//!
//! Two shortcuts, both outside the program under test:
//!
//! - Prices are written straight into the `PriceUpdateV2` account a market
//!   reads, owned by `mock_pyth`, rather than posted through it. A devnet
//!   build of `mock_pyth` only takes posts from the relay key, which a test
//!   cannot sign as. The bytes are the same either way, and `unwind::oracle`
//!   still checks owner, discriminator, verification, feed id and staleness.
//! - USDC and LP token accounts and the USDC mint are written directly too, so
//!   the bootstrap needs no SPL instructions of its own.

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
use unwind::state::{Batch, Market, Pool, Position};

pub const MOCK_PYTH_ID: Pubkey = anchor_lang::prelude::pubkey!("J1FKStdEnsAK69gV4G5nVTm6eZTquo5kwQdLCHctE2k4");
const COMPUTE_BUDGET_ID: Pubkey =
    anchor_lang::prelude::pubkey!("ComputeBudget111111111111111111111111111111");

pub const N_TRADERS: usize = 4;
pub const N_LPS: usize = 2;
pub const N_BACKERS: usize = 2;
pub const USD: u64 = 1_000_000;

pub const TRADER_FUNDS: u64 = 200_000 * USD;
pub const LP_FUNDS: u64 = 2_000_000 * USD;
pub const BACKER_FUNDS: u64 = 500_000 * USD;
pub const LP_SEED: [u64; N_LPS] = [1_000_000 * USD, 250_000 * USD];
/// What backer 0 posts behind each market at bootstrap: one deep, one
/// middling and one thin enough that its winners can outrun it.
pub const BACKING_SEED_USD: [u64; 3] = [100_000 * USD, 25_000 * USD, 8_000 * USD];

const START_UNIX: i64 = 1_800_000_000;
const START_SLOT: u64 = 1_000;

/// Confidence posted with every price, in bps of it: inside every market's
/// `max_conf_bps`, and wide enough to put a confidence term in the spread.
pub const CONF_BPS: u64 = 10;

/// One listed market and the oracle account behind it.
#[derive(Clone, Debug)]
pub struct MarketFx {
    pub feed_id: [u8; 32],
    pub market: Pubkey,
    pub batch: Pubkey,
    pub price_account: Pubkey,
    /// The price the relay last posted, `PRICE_SCALE`.
    pub price: u64,
}

/// How a transaction ended.
#[derive(Clone, Debug)]
pub enum TxOutcome {
    Ok,
    /// The program refused it. `code` is the custom error code when there is
    /// one, with its `PerpError` name.
    Rejected { code: Option<u32>, name: String },
    /// The program panicked or ran out of compute: never an acceptable way
    /// to refuse, since a panic in a permissionless crank holds a market.
    Aborted { reason: String, logs: Vec<String> },
}

pub struct Env {
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
    /// Logs of the last transaction that landed, for the events in them.
    pub last_logs: Vec<String>,
}

impl Clone for Env {
    fn clone(&self) -> Self {
        Env {
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
            last_logs: vec![],
        }
    }
}

pub fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &unwind::ID).0
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
    Pubkey::find_program_address(&[b"fuzz-token", owner.as_ref(), mint.as_ref()], &MOCK_PYTH_ID).0
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

impl Env {
    // ------------------------------------------------------------ bootstrap

    /// Builds the fixture: programs, mint, pool, three markets with live
    /// prices and backing, two LPs' deposits, funded traders.
    pub fn bootstrap() -> Env {
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
            last_logs: vec![],
        };

        // USDC: everybody's balance is minted up front, so the mint's supply
        // is the total the harness ever puts in.
        let mut balances: Vec<(Pubkey, u64)> = vec![(env.authority.pubkey(), 0)];
        balances.extend(env.traders.iter().map(|k| (k.pubkey(), TRADER_FUNDS)));
        balances.extend(env.lps.iter().map(|k| (k.pubkey(), LP_FUNDS)));
        balances.extend(env.backers.iter().map(|k| (k.pubkey(), BACKER_FUNDS)));
        let supply: u64 = balances.iter().map(|b| b.1).sum();
        env.write_mint(usdc_mint, env.authority.pubkey(), supply);
        for (owner, amount) in balances {
            env.write_token_account(owner, usdc_mint, amount);
        }

        env.expect_ok(env.ix_initialize_pool(), "initialize_pool");
        for k in env.lps.iter().map(|k| k.pubkey()).collect::<Vec<_>>() {
            env.write_token_account(k, lp_mint, 0);
        }

        // Three markets with different leverage and margin, so liquidation,
        // the band and the budget meet different numbers in each.
        let specs: [(&str, u64, u32, u16); 3] = [
            ("ALPHA", 100 * USD, 100_000, 500),
            ("BETA", 20 * USD, 200_000, 250),
            ("GAMMA", 3_000 * USD, 50_000, 1_000),
        ];
        for (i, (sym, price, lev, mm)) in specs.into_iter().enumerate() {
            let mut feed_id = [0u8; 32];
            feed_id[..sym.len()].copy_from_slice(sym.as_bytes());
            feed_id[31] = i as u8;
            let gen = 1u32;
            let market = pda(&[MARKET_SEED, pool.as_ref(), &feed_id, &gen.to_le_bytes()]);
            let fx = MarketFx {
                feed_id,
                market,
                batch: pda(&[BATCH_SEED, market.as_ref()]),
                price_account: Pubkey::find_program_address(&[b"price", &feed_id], &MOCK_PYTH_ID).0,
                price,
            };
            env.markets.push(fx);
            env.post_price(i, price);
            env.expect_ok(env.ix_add_market(i, sym, lev, mm), "add_market");
            env.expect_ok(env.ix_create_batch(i), "create_batch");
        }

        // Backing first: a market with no budget cannot open a position.
        for m in 0..env.markets.len() {
            env.expect_ok(env.ix_back_market(0, m, BACKING_SEED_USD[m]), "back_market");
        }
        for (i, amount) in LP_SEED.into_iter().enumerate() {
            env.expect_ok(env.ix_checkpoint_aum(true, &[]), "checkpoint_aum");
            env.expect_ok(env.ix_add_liquidity(i, amount), "add_liquidity");
        }
        env
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

    fn write_mint(&mut self, mint: Pubkey, authority: Pubkey, supply: u64) {
        let m = spl_token::state::Mint {
            mint_authority: COption::Some(authority),
            supply,
            decimals: 6,
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

    /// Writes market `m`'s oracle account at `price`, published now. The
    /// account is what `mock_pyth::post_price` would leave behind.
    pub fn post_price(&mut self, m: usize, price: u64) {
        let c = self.clock();
        let fx = &mut self.markets[m];
        fx.price = price;
        let update = unwind::oracle::PriceUpdateV2 {
            write_authority: MOCK_PYTH_ID,
            verification_level: unwind::oracle::VerificationLevel::Full,
            price_message: unwind::oracle::PriceFeedMessage {
                feed_id: fx.feed_id,
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
        let addr = fx.price_account;
        self.svm
            .set_account(addr, Account { lamports, data, owner: MOCK_PYTH_ID, executable: false, rent_epoch: 0 })
            .expect("price");
    }

    /// Reposts every market's current price at the current time, as the
    /// relay does every few seconds.
    pub fn repost_all(&mut self) {
        for m in 0..self.markets.len() {
            let p = self.markets[m].price;
            self.post_price(m, p);
        }
    }

    // ------------------------------------------------------------ sending

    /// Sends `ix` signed by `signer`, under a raised compute limit.
    pub fn send(&mut self, (ix, signer): (Instruction, Keypair)) -> TxOutcome {
        let mut cu = vec![2u8];
        cu.extend_from_slice(&1_400_000u32.to_le_bytes());
        let budget = Instruction { program_id: COMPUTE_BUDGET_ID, accounts: vec![], data: cu };
        let msg = Message::new(&[budget, ix], Some(&signer.pubkey()));
        let tx = Transaction::new(&[&signer], msg, self.svm.latest_blockhash());
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
        self.svm.get_account(k)
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

    pub fn batch_state(&self, m: usize) -> Batch {
        let a = self.account(&self.markets[m].batch).expect("batch");
        bytemuck::pod_read_unaligned(&a.data[8..8 + std::mem::size_of::<Batch>()])
    }

    pub fn position_address(&self, m: usize, owner: &Pubkey) -> Pubkey {
        pda(&[POSITION_SEED, self.markets[m].market.as_ref(), owner.as_ref()])
    }

    pub fn position_state(&self, m: usize, owner: &Pubkey) -> Option<Position> {
        self.anchor(&self.position_address(m, owner))
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

    pub fn withdraw_request(&self, owner: &Pubkey) -> Pubkey {
        pda(&[WITHDRAW_REQUEST_SEED, self.pool.as_ref(), owner.as_ref()])
    }

    pub fn withdraw_escrow(&self, owner: &Pubkey) -> Pubkey {
        pda(&[WITHDRAW_ESCROW_SEED, self.withdraw_request(owner).as_ref()])
    }

    // ------------------------------------------------------------ instructions

    fn ix<A: ToAccountMetas, D: InstructionData>(accounts: A, data: D) -> Instruction {
        Instruction { program_id: unwind::ID, accounts: accounts.to_account_metas(None), data: data.data() }
    }

    fn checkpoint(&self) -> Pubkey {
        pda(&[AUM_SEED, self.pool.as_ref()])
    }

    fn trader_record(owner: &Pubkey) -> Pubkey {
        pda(&[TRADER_SEED, owner.as_ref()])
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
            program_data: Pubkey::find_program_address(&[unwind::ID.as_ref()], &bpf_loader_upgradeable::ID).0,
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

    fn ix_add_market(&self, m: usize, symbol: &str, max_leverage_bps: u32, mm_bps: u16) -> (Instruction, Keypair) {
        let fx = &self.markets[m];
        let mut sym = [0u8; 16];
        sym[..symbol.len()].copy_from_slice(symbol.as_bytes());
        let params = unwind::instructions::MarketParams {
            symbol: sym,
            feed_id: fx.feed_id,
            max_price_age_sec: 60,
            max_conf_bps: 200,
            max_leverage_bps,
            maintenance_margin_bps: mm_bps,
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
            price_source: 0,
            observation: Pubkey::default(),
        };
        let accounts = unwind::accounts::AddMarket {
            payer: self.authority.pubkey(),
            pool: self.pool,
            generations: pda(&[MARKET_GENERATION_SEED, self.pool.as_ref(), &fx.feed_id]),
            market: fx.market,
            system_program: anchor_lang::system_program::ID,
        };
        (
            Self::ix(accounts, unwind::instruction::AddMarket { params, generation: 1 }),
            self.authority.insecure_clone(),
        )
    }

    fn ix_create_batch(&self, m: usize) -> (Instruction, Keypair) {
        let fx = &self.markets[m];
        let accounts = unwind::accounts::CreateBatch {
            payer: self.authority.pubkey(),
            pool: self.pool,
            market: fx.market,
            batch: fx.batch,
            system_program: anchor_lang::system_program::ID,
        };
        (Self::ix(accounts, unwind::instruction::CreateBatch {}), self.authority.insecure_clone())
    }

    pub fn ix_back_market(&self, backer: usize, m: usize, amount: u64) -> (Instruction, Keypair) {
        let k = &self.backers[backer];
        let fx = &self.markets[m];
        let accounts = unwind::accounts::BackMarket {
            owner: k.pubkey(),
            pool: self.pool,
            market: fx.market,
            backing: pda(&[BACKING_SEED, fx.market.as_ref(), k.pubkey().as_ref()]),
            book: pda(&[BACKING_BOOK_SEED, fx.market.as_ref()]),
            deposit_mint: self.usdc_mint,
            deposit_vault: self.vault,
            owner_token: token_account_address(&k.pubkey(), &self.usdc_mint),
            trader: Self::trader_record(&k.pubkey()),
            token_program: spl_token::ID,
            system_program: anchor_lang::system_program::ID,
        };
        (Self::ix(accounts, unwind::instruction::BackMarket { amount }), k.insecure_clone())
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
            book: pda(&[BACKING_BOOK_SEED, fx.market.as_ref()]),
            usdc_mint: self.usdc_mint,
            usdc_vault: self.vault,
            owner_usdc: token_account_address(&k.pubkey(), &self.usdc_mint),
            trader: Self::trader_record(&k.pubkey()),
            token_program: spl_token::ID,
            system_program: anchor_lang::system_program::ID,
        };
        (Self::ix(accounts, unwind::instruction::UnbackMarket { shares }), k.insecure_clone())
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

    pub fn ix_checkpoint_aum(&self, restart: bool, pairs: &[AccountMeta]) -> (Instruction, Keypair) {
        let accounts = unwind::accounts::CheckpointAum {
            payer: self.authority.pubkey(),
            pool: self.pool,
            checkpoint: self.checkpoint(),
            system_program: anchor_lang::system_program::ID,
        };
        let mut ix = Self::ix(accounts, unwind::instruction::CheckpointAum { restart });
        ix.accounts.extend_from_slice(pairs);
        (ix, self.authority.insecure_clone())
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
        (
            Self::ix(accounts, unwind::instruction::AddLiquidity { amount_usd: amount, min_lp_out: 0 }),
            k.insecure_clone(),
        )
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
            token_claim: pda(&[LP_TOKEN_CLAIM_SEED, self.pool.as_ref(), k.pubkey().as_ref()]),
            token_program: spl_token::ID,
            system_program: anchor_lang::system_program::ID,
        };
        (
            Self::ix(accounts, unwind::instruction::ClaimWithdraw { lp_amount, min_usd_out: 0 }),
            k.insecure_clone(),
        )
    }

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
        (Self::ix(accounts, unwind::instruction::ClearBatch {}), self.authority.insecure_clone())
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
        (Self::ix(accounts, unwind::instruction::SettleOrder { index }), self.authority.insecure_clone())
    }

    pub fn ix_accrue_funding(&self, m: usize) -> (Instruction, Keypair) {
        let accounts = unwind::accounts::AccrueFunding { pool: self.pool, market: self.markets[m].market };
        (Self::ix(accounts, unwind::instruction::AccrueFunding {}), self.authority.insecure_clone())
    }

    pub fn ix_step_risk_price(&self, m: usize) -> (Instruction, Keypair) {
        let fx = &self.markets[m];
        let accounts = unwind::accounts::StepRiskPrice {
            pool: self.pool,
            market: fx.market,
            price_update: fx.price_account,
        };
        (Self::ix(accounts, unwind::instruction::StepRiskPrice {}), self.authority.insecure_clone())
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
        (Self::ix(accounts, unwind::instruction::Liquidate {}), self.authority.insecure_clone())
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
            TxOutcome::Rejected { code: Some(*code), name: error_name(*code) }
        }
        TransactionError::InstructionError(_, InstructionError::ComputationalBudgetExceeded)
        | TransactionError::InstructionError(_, InstructionError::ProgramFailedToComplete) => {
            TxOutcome::Aborted { reason: format!("{err:?}"), logs }
        }
        other => TxOutcome::Rejected { code: None, name: format!("{other:?}") },
    }
}
