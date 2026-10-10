//! Underwriting a market, permissionlessly.
//!
//! Listing was already open to anyone; underwriting was not, and that made the
//! openness hollow. A stranger could create a market and then wait on the pool
//! authority to grant it an allowance, which meant every listing still needed
//! us to say yes. Backing removes that step by making the allowance collateral
//! rather than permission: whoever wants the market to exist posts money, the
//! budget rises to what was posted, and that money is the first thing the
//! market's losses consume.
//!
//! It is strictly safer than the authority route it replaces. An authority
//! granting a budget is writing a cheque against LP capital for a market it
//! may know nothing about. A backer posting one is putting their own money
//! where their conviction is, and the LPs are behind them rather than in front.
//!
//! Backing is held in whatever it was posted in: USDC in the pool's vault, as
//! it always was, and SOL or USDT in a custody of their own, the way Jupiter's
//! JLP pool holds each asset (`state/custody.rs`). A backer's share is a claim
//! on the whole pot at the oracle, and comes back out in the same mix.
use crate::constants::*;
use crate::instructions::batch::{market_price, open_trader};
use crate::errors::PerpError;
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

/// One backer's stake in one market.
#[account]
#[derive(InitSpace)]
pub struct Backing {
    pub bump: u8,
    pub market: Pubkey,
    pub owner: Pubkey,
    /// Claims on the market's backing pot, not a USD amount. What they are
    /// worth moves with the market's drawdown and with the prices of what the
    /// pot holds, which is the whole of being a backer.
    pub shares: u64,
    /// Posted, cumulative, in USD at the time. Kept for reporting: a backer
    /// wants to see what they put in next to what it is worth now, and the
    /// share price alone does not say that.
    pub deposited_usd: u64,
    /// What this stake counts for in the owner's backing points: USD posted,
    /// less a proportional part for every share taken back out. Unlike
    /// `deposited_usd` it falls on the way out, so a wallet that has left a
    /// market stops earning on it.
    pub points_basis_usd: u64,
}

/// The pool's custodies, each with its current price, from `(custody, price)`
/// pairs in index order. Every custody must be present: a pot valued against
/// part of what it holds would sell shares at the wrong price.
fn load_custodies<'info>(
    pool: &Pool,
    pool_key: Pubkey,
    pairs: &'info [AccountInfo<'info>],
) -> Result<Vec<(Account<'info, Custody>, u64)>> {
    let n = pool.num_custodies as usize;
    require!(pairs.len() == n * 2, PerpError::IncompleteCustodyList);
    let mut out: Vec<(Account<'info, Custody>, u64)> = Vec::with_capacity(n);
    for pair in pairs.chunks(2) {
        let c: Account<'info, Custody> = Account::try_from(&pair[0])?;
        require_keys_eq!(c.pool, pool_key, PerpError::MarketPoolMismatch);
        require!(c.index as usize == out.len(), PerpError::IncompleteCustodyList);
        let price = c.price(&pair[1], &pool.pyth_receiver)?;
        out.push((c, price));
    }
    Ok(out)
}

fn held(book: &BackingBook, custodies: &[(Account<Custody>, u64)]) -> Vec<Held> {
    custodies
        .iter()
        .map(|(c, price)| Held {
            amount: book.amounts[c.index as usize],
            price: *price,
            decimals: c.decimals,
            is_stable: c.is_stable,
            weight_bps: c.budget_weight_bps,
        })
        .collect()
}

/// Brings in-kind backing up to date with what the LPs have covered, then
/// holds the budget to what the pot is still worth. Run before anything reads
/// the pot, so a price is never quoted off a stale split.
fn sync(
    pool: &mut Pool,
    market: &mut Market,
    book: &mut BackingBook,
    custodies: &mut [(Account<Custody>, u64)],
) -> Result<()> {
    let plan = plan_sync_with_fund(
        lp_borne_usd(market.net_loss_usd, market.backing_drawn_usd),
        book.baseline_usd,
        book.reimbursed_usd,
        book.fund_reimbursed_usd,
        market.insurance_drawn_usd,
        &held(book, custodies),
        pool.free_liquidity_usd(),
    )?;
    // The fund first, in tokens, which it holds from here
    // (`Custody::insurance_amount`); and out of whatever the LPs were handed
    // for a loss that is no longer theirs.
    if plan.fund_in_kind_usd > 0 || plan.fund_usdc > 0 {
        for (c, _) in custodies.iter_mut() {
            let i = c.index as usize;
            let t = plan.fund_taken[i];
            if t == 0 {
                continue;
            }
            book.amounts[i] -= t;
            c.backing_amount = c.backing_amount.saturating_sub(t);
            c.insurance_amount = c
                .insurance_amount
                .checked_add(t)
                .ok_or(PerpError::MathOverflow)?;
        }
        pool.liquidity_usd -= plan.fund_usdc;
        pool.insurance_usd = pool
            .insurance_usd
            .checked_add(plan.fund_usdc)
            .ok_or(PerpError::MathOverflow)?;
        let repaid = plan.fund_in_kind_usd + plan.fund_usdc;
        market.insurance_drawn_usd = market.insurance_drawn_usd.saturating_sub(repaid);
        book.reimbursed_usd = book
            .reimbursed_usd
            .checked_add(plan.fund_in_kind_usd)
            .ok_or(PerpError::MathOverflow)?;
        book.fund_reimbursed_usd = book
            .fund_reimbursed_usd
            .checked_add(repaid)
            .ok_or(PerpError::MathOverflow)?;
        emit!(BackingRepaidFund {
            market: book.market,
            in_kind_usd: plan.fund_in_kind_usd,
            taken: plan.fund_taken,
            usdc_usd: plan.fund_usdc,
        });
    }
    match plan.sync {
        Sync::Nothing => {}
        Sync::PayLps { usd, taken } => {
            for (c, _) in custodies.iter_mut() {
                let i = c.index as usize;
                let t = taken[i];
                if t == 0 {
                    continue;
                }
                book.amounts[i] -= t;
                c.backing_amount = c.backing_amount.saturating_sub(t);
                c.lp_amount = c.lp_amount.checked_add(t).ok_or(PerpError::MathOverflow)?;
            }
            book.reimbursed_usd = book
                .reimbursed_usd
                .checked_add(usd)
                .ok_or(PerpError::MathOverflow)?;
            emit!(BackingPaidLps { market: book.market, amount_usd: usd, taken });
        }
        // Nothing is refunded into a pot nobody holds a share of: the backers
        // whose tokens paid the LPs have left, and money put back with no
        // shares against it would go to whoever backed the market next, as
        // `restore_backing` already refuses for USDC.
        Sync::Refund { .. } if market.backing_shares == 0 => {}
        Sync::Refund { usd } => {
            pool.liquidity_usd -= usd;
            pool.backing_usd = pool.backing_usd.checked_add(usd).ok_or(PerpError::MathOverflow)?;
            market.backing_usd = market
                .backing_usd
                .checked_add(usd)
                .ok_or(PerpError::MathOverflow)?;
            book.reimbursed_usd -= usd;
            book.fund_reimbursed_usd =
                fund_after_refund(book.fund_reimbursed_usd, plan.fund_target, usd);
            emit!(BackingRefunded { market: book.market, amount_usd: usd });
        }
    }

    // Tokens the fund holds, from this market or any other, go to the LPs
    // for USDC at the oracle while there is free liquidity to pay with.
    for (c, price) in custodies.iter_mut() {
        if c.insurance_amount == 0 {
            continue;
        }
        let h = Held {
            amount: c.insurance_amount,
            price: *price,
            decimals: c.decimals,
            is_stable: c.is_stable,
            weight_bps: c.budget_weight_bps,
        };
        let (tokens, usd) = fund_tokens_bought(&h, pool.free_liquidity_usd())?;
        if tokens == 0 {
            continue;
        }
        c.insurance_amount -= tokens;
        c.lp_amount = c.lp_amount.checked_add(tokens).ok_or(PerpError::MathOverflow)?;
        pool.liquidity_usd -= usd;
        pool.insurance_usd = pool.insurance_usd.checked_add(usd).ok_or(PerpError::MathOverflow)?;
        emit!(FundTokensSoldToLps { mint: c.mint, amount: tokens, usd });
    }

    // A falling price shrinks what the backing can stand behind, and the
    // budget follows it down. It does not follow a rising one back up by
    // itself: raising an allowance is something somebody posts money to do.
    let h = held(book, custodies);
    if in_kind_value(&h)? > 0 {
        let cover = market
            .backing_usd
            .checked_add(in_kind_weighted(&h)?)
            .ok_or(PerpError::MathOverflow)?;
        market.loss_budget_usd = market
            .loss_budget_usd
            .min(budget_cap(cover, market.net_loss_usd));
    }
    Ok(())
}

fn exit_custodies(custodies: &[(Account<Custody>, u64)]) -> Result<()> {
    for (c, _) in custodies {
        c.exit(&crate::ID)?;
    }
    Ok(())
}

/// The budget a deposit counting `counted` toward it leaves a market with.
///
/// Raised by what was just posted, never past what stands behind the market
/// (`cover`), and never lowered: a market the authority underwrote above its
/// backing keeps that figure. Only new money raises it. Setting it to the
/// whole cover instead let fee income, which is the backers' and nobody chose
/// to put at risk, widen the allowance, and let a deposit of one unit undo a
/// cut `derive_market_budget` had just made to the pool's depth.
pub fn raised_budget(budget: u64, cover: u64, counted: u64) -> u64 {
    budget.max(budget.saturating_add(counted).min(cover))
}

/// The most a market's budget may stand at when `cover` is behind it now.
///
/// The budget is a lifetime allowance, read net of what the market has
/// already cost (`remaining_budget_usd`), while the cover is what is left
/// after those losses were drawn from it. Capping one with the other directly
/// counted every loss twice: a market $30k into a $50k budget with $20k of
/// backing left fell to nothing remaining when a single unit was withdrawn.
/// Adding back what was spent keeps the remaining budget at most the cover,
/// and lets a deposit raise the remaining budget by what it counts for.
pub fn budget_cap(cover: u64, net_loss_usd: i64) -> u64 {
    cover.saturating_add(net_loss_usd.max(0) as u64)
}

/// What a new backing share is priced against: the pot, plus what earlier
/// losses took out of it and a later gain will put back (`backing_drawn_usd`
/// in USDC, `reimbursed_usd` in kind).
///
/// Those repayments belong to the shares that were drawn on. Priced against
/// the pot alone, a deposit just before a repayment bought into it at the
/// drawn-down price: $10k into a $100k market drawn to $10k bought half the
/// shares, and the $90k repayment then paid that $10k back $55k. Priced with
/// the claim, a new share pays for its part of the repayment at face, and a
/// share that leaves takes only the pot and leaves its part of the claim to
/// the backers who stay, so going in and straight back out never profits.
pub fn entry_pot_usd(pot_usd: u64, drawn_usd: u64, reimbursed_usd: u64) -> Result<u64> {
    pot_usd
        .checked_add(drawn_usd)
        .and_then(|v| v.checked_add(reimbursed_usd))
        .ok_or(PerpError::MathOverflow.into())
}

/// `shares` of `total`'s part of `x`, one of the pot's holdings, less the
/// same fraction of `held_back_usd`, what the market's traders are up at the
/// mark and the backing would pay them now (`Market::backing_owed_usd`).
///
/// A backer who leaves while a loss is visible leaves their part of it
/// behind, for the backers who stay to pay or to get back if the price turns.
/// Rounds down.
pub fn exit_part(x: u64, shares: u64, total: u64, pot_usd: u64, held_back_usd: u64) -> u64 {
    if total == 0 || pot_usd == 0 {
        return 0;
    }
    let base = (x as u128) * (shares as u128) / (total as u128);
    let free = pot_usd.saturating_sub(held_back_usd) as u128;
    (base * free / (pot_usd as u128)) as u64
}

/// How much of a stake's points basis to drop when its shares are worth
/// `value_usd`: whatever the market's losses have taken from it. A stake
/// earns backing points on money still at risk, not on money already lost.
pub fn basis_cut(basis: u64, value_usd: u64) -> u64 {
    basis.saturating_sub(value_usd)
}

/// Whether a failed price read means the price is unusable right now rather
/// than that the wrong account was passed. As `aum::price_unusable`.
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

/// What a leaving backer leaves behind for the market's open positions: what
/// its traders are up, at whichever of the oracle and the risk price makes it
/// more, and at the most the budget would pay when the price cannot be read.
fn held_back_usd(market: &Market, price: Result<u64>, pot_usd: u64) -> Result<u64> {
    if !market.has_open_interest() {
        return Ok(0);
    }
    let owed = match price {
        Ok(p) => {
            let at_oracle = market.backing_owed_usd(p)?;
            if market.risk_price == 0 || market.risk_price == p {
                at_oracle
            } else {
                at_oracle.max(market.backing_owed_usd(market.risk_price)?)
            }
        }
        Err(e) if price_unusable(&e) => market.remaining_budget_usd(),
        Err(e) => return Err(e),
    };
    Ok(owed.min(pot_usd))
}

#[derive(Accounts)]
pub struct BackMarket<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(mut, seeds = [POOL_SEED, pool.usdc_mint.as_ref()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,

    #[account(mut, has_one = pool @ PerpError::MarketPoolMismatch)]
    pub market: Box<Account<'info, Market>>,

    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + Backing::INIT_SPACE,
        seeds = [BACKING_SEED, market.key().as_ref(), owner.key().as_ref()],
        bump,
    )]
    pub backing: Box<Account<'info, Backing>>,

    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + BackingBook::INIT_SPACE,
        seeds = [BACKING_BOOK_SEED, market.key().as_ref()],
        bump,
    )]
    pub book: Box<Account<'info, BackingBook>>,

    /// USDC, or the mint of one of the pool's custodies.
    pub deposit_mint: Box<InterfaceAccount<'info, Mint>>,

    /// The pool's USDC vault for USDC, the custody's vault otherwise; checked
    /// against whichever the mint says.
    #[account(mut, constraint = deposit_vault.mint == deposit_mint.key())]
    pub deposit_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = owner_token.mint == deposit_mint.key(),
        constraint = owner_token.owner == owner.key(),
    )]
    pub owner_token: Box<InterfaceAccount<'info, TokenAccount>>,

    /// The backer's points record: backing earns points for as long as it
    /// stays in.
    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + Trader::INIT_SPACE,
        seeds = [TRADER_SEED, owner.key().as_ref()],
        bump,
    )]
    pub trader: Box<Account<'info, Trader>>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

/// Posts `amount` of the deposit token behind a market, in that token's base
/// units, and raises the market's budget by what it counts for.
///
/// `remaining_accounts` are `(custody, price_update)` for every custody the
/// pool has, in index order; a stable custody's price account is not read, and
/// any account will do in its place.
///
/// The budget rises by what this deposit counts for (`raised_budget`), never
/// past what stands behind the market. A market the authority had already
/// underwritten keeps whichever figure is larger: backing is meant to open the
/// door for markets nobody underwrote, not to shrink the ones somebody did.
pub fn back_market<'info>(
    ctx: Context<'_, '_, 'info, 'info, BackMarket<'info>>,
    amount: u64,
) -> Result<()> {
    require!(amount > 0, PerpError::ZeroAmount);
    require!(!ctx.accounts.pool.paused, PerpError::PoolPaused);
    require!(!ctx.accounts.market.paused, PerpError::MarketPaused);

    let pool_key = ctx.accounts.pool.key();
    let mut custodies = load_custodies(&ctx.accounts.pool, pool_key, ctx.remaining_accounts)?;

    let book = &mut ctx.accounts.book;
    if book.market == Pubkey::default() {
        book.bump = ctx.bumps.book;
        book.market = ctx.accounts.market.key();
    }
    // What the market owes the LPs before backing moves, so a checkpoint
    // taken before this sees the change (`aum::book_lp_drift`).
    let owed_before = crate::aum::lp_owed_now(&ctx.accounts.market)?;
    sync(&mut ctx.accounts.pool, &mut ctx.accounts.market, book, &mut custodies)?;

    let h = held(book, &custodies);
    let pot_usd = ctx
        .accounts
        .market
        .backing_usd
        .checked_add(in_kind_value(&h)?)
        .ok_or(PerpError::MathOverflow)?;

    // What was posted, and what it is worth.
    let mint = ctx.accounts.deposit_mint.key();
    let custody_pos = if mint == ctx.accounts.pool.usdc_mint {
        require_keys_eq!(
            ctx.accounts.deposit_vault.key(),
            ctx.accounts.pool.usdc_vault,
            PerpError::InvalidParameter
        );
        None
    } else {
        let pos = custodies
            .iter()
            .position(|(c, _)| c.mint == mint)
            .ok_or(PerpError::UnknownCustody)?;
        require_keys_eq!(
            ctx.accounts.deposit_vault.key(),
            custodies[pos].0.vault,
            PerpError::InvalidParameter
        );
        Some(pos)
    };
    let amount_usd = match custody_pos {
        None => amount,
        Some(p) => token_value_usd(amount, custodies[p].1, custodies[p].0.decimals)?,
    };
    require!(amount_usd > 0, PerpError::ZeroAmount);

    let entry_usd = entry_pot_usd(
        pot_usd,
        ctx.accounts.market.backing_drawn_usd,
        ctx.accounts.book.reimbursed_usd,
    )?;
    let shares = shares_for(amount_usd, ctx.accounts.market.backing_shares, entry_usd)?;
    require!(shares > 0, PerpError::ZeroAmount);

    // What the stake already in is worth now, for its points: a stake the
    // market's losses have drawn on stops earning on what was lost.
    let stake_usd = if ctx.accounts.market.backing_shares == 0 {
        0
    } else {
        ((pot_usd as u128) * (ctx.accounts.backing.shares as u128)
            / (ctx.accounts.market.backing_shares as u128)) as u64
    };
    let cut = basis_cut(ctx.accounts.backing.points_basis_usd, stake_usd);

    transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.owner_token.to_account_info(),
                mint: ctx.accounts.deposit_mint.to_account_info(),
                to: ctx.accounts.deposit_vault.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.deposit_mint.decimals,
    )?;

    let book = &mut ctx.accounts.book;
    let market = &mut ctx.accounts.market;
    let pool = &mut ctx.accounts.pool;
    // A market nobody backs any more starts its new backers clean: what was
    // drawn from the ones who left is not theirs to be repaid, and a later
    // gain would otherwise hand it to them.
    if market.backing_shares == 0 {
        market.backing_drawn_usd = 0;
        // Likewise in kind: what earlier backers' tokens paid the LPs is not
        // these backers' to be refunded, and losses before now are not
        // theirs to repay.
        book.reimbursed_usd = 0;
        book.fund_reimbursed_usd = 0;
        book.baseline_usd = lp_borne_usd(market.net_loss_usd, 0);
    }
    match custody_pos {
        None => {
            market.backing_usd = market
                .backing_usd
                .checked_add(amount)
                .ok_or(PerpError::MathOverflow)?;
            pool.backing_usd = pool
                .backing_usd
                .checked_add(amount)
                .ok_or(PerpError::MathOverflow)?;
        }
        Some(p) => {
            // The first tokens into an empty pot start its obligation to the
            // LPs from here: what they covered before it existed is not its
            // to repay.
            if book.amounts.iter().all(|&a| a == 0) {
                book.baseline_usd = lp_borne_usd(market.net_loss_usd, market.backing_drawn_usd)
                    .saturating_sub(book.reimbursed_usd as i64);
            }
            let c = &mut custodies[p].0;
            let i = c.index as usize;
            book.amounts[i] = book.amounts[i]
                .checked_add(amount)
                .ok_or(PerpError::MathOverflow)?;
            c.backing_amount = c
                .backing_amount
                .checked_add(amount)
                .ok_or(PerpError::MathOverflow)?;
        }
    }
    market.backing_shares = market
        .backing_shares
        .checked_add(shares)
        .ok_or(PerpError::MathOverflow)?;
    let cover = market
        .backing_usd
        .checked_add(in_kind_weighted(&held(book, &custodies))?)
        .ok_or(PerpError::MathOverflow)?;
    let counted = match custody_pos {
        None => amount,
        Some(p) => {
            let c = &custodies[p];
            Held {
                amount,
                price: c.1,
                decimals: c.0.decimals,
                is_stable: c.0.is_stable,
                weight_bps: c.0.budget_weight_bps,
            }
            .weighted()?
        }
    };
    market.loss_budget_usd = raised_budget(
        market.loss_budget_usd,
        budget_cap(cover, market.net_loss_usd),
        counted,
    );
    crate::aum::book_lp_drift(pool, market, owed_before)?;

    let backing = &mut ctx.accounts.backing;
    backing.bump = ctx.bumps.backing;
    backing.market = market.key();
    backing.owner = ctx.accounts.owner.key();
    backing.shares = backing
        .shares
        .checked_add(shares)
        .ok_or(PerpError::MathOverflow)?;
    backing.deposited_usd = backing
        .deposited_usd
        .checked_add(amount_usd)
        .ok_or(PerpError::MathOverflow)?;
    // A pool that earns no points (`Pool::no_points`) records no stake, so a
    // later withdrawal takes nothing off a stake earned elsewhere.
    let no_points = ctx.accounts.pool.no_points;
    let earned_usd = if no_points { 0 } else { amount_usd };
    backing.points_basis_usd = (backing.points_basis_usd - cut)
        .checked_add(earned_usd)
        .ok_or(PerpError::MathOverflow)?;

    // Points up to now at the old stake, then the stake is marked to what
    // is left of it and grows.
    let now = Clock::get()?.unix_timestamp;
    let owner = ctx.accounts.owner.key();
    let trader = &mut ctx.accounts.trader;
    open_trader(trader, owner, ctx.bumps.trader, now);
    if !no_points {
        trader.accrue_backing(now)?;
        trader.backing_usd = trader
            .backing_usd
            .saturating_sub(cut)
            .checked_add(earned_usd)
            .ok_or(PerpError::MathOverflow)?;
    }

    exit_custodies(&custodies)?;
    emit!(MarketBacked {
        market: market.key(),
        owner: backing.owner,
        mint,
        amount,
        amount_usd,
        shares,
        backing_usd: market.backing_usd,
        budget_usd: market.loss_budget_usd,
    });
    Ok(())
}

/// What `unback_market` does to the market and the pool once the tokens have
/// gone: `usdc_out` and `shares` out, the budget held to what is left
/// behind it (`in_kind_left` is the weighted in-kind backing left), and the
/// change in what the market owes the LPs since `owed_before`
/// (`aum::lp_owed_now`, read before `sync`) booked as AUM drift. Without the
/// drift, a checkpoint taken while the backing stood in front of winners
/// would keep counting it there after it left, and an LP claim read from that
/// checkpoint would be paid out of the backing that had gone.
fn book_unback(
    pool: &mut Pool,
    market: &mut Market,
    usdc_out: u64,
    shares: u64,
    in_kind_left: u64,
    owed_before: i64,
) -> Result<()> {
    market.backing_usd -= usdc_out;
    market.backing_shares -= shares;
    // The budget follows the money down: what is left of it is at most the
    // backing left. A market whose backers have left is a market that may
    // not open new exposure, which is the same state it was in before anyone
    // backed it.
    let cover = market
        .backing_usd
        .checked_add(in_kind_left)
        .ok_or(PerpError::MathOverflow)?;
    market.loss_budget_usd = market
        .loss_budget_usd
        .min(budget_cap(cover, market.net_loss_usd));
    pool.backing_usd = pool.backing_usd.saturating_sub(usdc_out);
    crate::aum::book_lp_drift(pool, market, owed_before)
}

#[derive(Accounts)]
pub struct UnbackMarket<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(mut, seeds = [POOL_SEED, pool.usdc_mint.as_ref()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,

    #[account(mut, has_one = pool @ PerpError::MarketPoolMismatch)]
    pub market: Box<Account<'info, Market>>,

    /// CHECK: the market's price, validated by `market_price` against the
    /// market's own source. Read only while the market has open interest.
    pub price_update: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [BACKING_SEED, market.key().as_ref(), owner.key().as_ref()],
        bump = backing.bump,
    )]
    pub backing: Box<Account<'info, Backing>>,

    /// Created here for a market backed before custodies existed, which has
    /// only USDC and so an empty book.
    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + BackingBook::INIT_SPACE,
        seeds = [BACKING_BOOK_SEED, market.key().as_ref()],
        bump,
    )]
    pub book: Box<Account<'info, BackingBook>>,

    #[account(address = pool.usdc_mint)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut, address = pool.usdc_vault)]
    pub usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = owner_usdc.mint == pool.usdc_mint,
        constraint = owner_usdc.owner == owner.key(),
    )]
    pub owner_usdc: Box<InterfaceAccount<'info, TokenAccount>>,

    /// The backer's points record: backing earns points for as long as it
    /// stays in.
    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + Trader::INIT_SPACE,
        seeds = [TRADER_SEED, owner.key().as_ref()],
        bump,
    )]
    pub trader: Box<Account<'info, Trader>>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

/// Withdraws backing: `shares` of the pot, paid in the pot's own mix.
///
/// `remaining_accounts` are the `(custody, price_update)` pairs, as for
/// `back_market`, followed by `(mint, custody_vault, owner_token)` for every
/// custody in the same order, so each token can be paid back in kind.
///
/// What a backer may take out is bounded twice: by what their shares are worth
/// after the market's losses, and by what the market's open positions still
/// need reserved. The second is the important one. Backing that walked out
/// from under live positions would leave the LPs holding exposure they never
/// underwrote, which is the failure this whole mechanism exists to prevent.
pub fn unback_market<'info>(
    ctx: Context<'_, '_, 'info, 'info, UnbackMarket<'info>>,
    shares: u64,
) -> Result<()> {
    require!(shares > 0, PerpError::ZeroAmount);
    require!(
        shares <= ctx.accounts.backing.shares,
        PerpError::InsufficientLiquidity
    );

    let pool_key = ctx.accounts.pool.key();
    let n = ctx.accounts.pool.num_custodies as usize;
    require!(
        ctx.remaining_accounts.len() == n * 5,
        PerpError::IncompleteCustodyList
    );
    let (pairs, payouts) = ctx.remaining_accounts.split_at(n * 2);
    let mut custodies = load_custodies(&ctx.accounts.pool, pool_key, pairs)?;

    let book = &mut ctx.accounts.book;
    if book.market == Pubkey::default() {
        book.bump = ctx.bumps.book;
        book.market = ctx.accounts.market.key();
    }
    let owed_before = crate::aum::lp_owed_now(&ctx.accounts.market)?;
    sync(&mut ctx.accounts.pool, &mut ctx.accounts.market, book, &mut custodies)?;

    let total = ctx.accounts.market.backing_shares;
    require!(total > 0, PerpError::ZeroAmount);

    let h = held(book, &custodies);
    let pot_usd = ctx
        .accounts
        .market
        .backing_usd
        .checked_add(in_kind_value(&h)?)
        .ok_or(PerpError::MathOverflow)?;

    // What the market's traders are up at the mark stays behind, the leaver's
    // part of it with the backers who stay. Without it backing was a free
    // option: earn the fees, and leave the moment a loss showed, so winners
    // were cut to nothing by a budget that followed the money out. Only the
    // visible loss is held, never the positions' full size, which froze the
    // pot whenever the market had any open interest at all.
    let held_back = {
        let market = &ctx.accounts.market;
        let price = if market.has_open_interest() {
            market_price(
                &ctx.accounts.price_update.to_account_info(),
                &ctx.accounts.pool,
                market,
                &market.key(),
            )
            .map(|o| o.price)
        } else {
            Ok(0)
        };
        held_back_usd(market, price, pot_usd)?
    };
    let part = |x: u64| exit_part(x, shares, total, pot_usd, held_back);
    let value_usd = part(pot_usd);
    require!(value_usd > 0, PerpError::ZeroAmount);

    // What the whole stake is worth before it leaves, for its points.
    let stake_usd =
        ((pot_usd as u128) * (ctx.accounts.backing.shares as u128) / (total as u128)) as u64;

    let usdc_mint_key = ctx.accounts.pool.usdc_mint;
    let bump = ctx.accounts.pool.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[POOL_SEED, usdc_mint_key.as_ref(), &[bump]]];

    let usdc_out = part(ctx.accounts.market.backing_usd);
    if usdc_out > 0 {
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.usdc_vault.to_account_info(),
                    mint: ctx.accounts.usdc_mint.to_account_info(),
                    to: ctx.accounts.owner_usdc.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                },
                signer_seeds,
            ),
            usdc_out,
            ctx.accounts.usdc_mint.decimals,
        )?;
    }

    let mut paid = [0u64; MAX_CUSTODIES];
    for (k, (c, _)) in custodies.iter_mut().enumerate() {
        let i = c.index as usize;
        let out = part(book.amounts[i]);
        let (mint_ai, vault_ai, to_ai) = (&payouts[k * 3], &payouts[k * 3 + 1], &payouts[k * 3 + 2]);
        require_keys_eq!(mint_ai.key(), c.mint, PerpError::UnknownCustody);
        require_keys_eq!(vault_ai.key(), c.vault, PerpError::UnknownCustody);
        if out == 0 {
            continue;
        }
        let to: InterfaceAccount<TokenAccount> = InterfaceAccount::try_from(to_ai)?;
        require_keys_eq!(to.owner, ctx.accounts.owner.key(), PerpError::Unauthorized);
        require_keys_eq!(to.mint, c.mint, PerpError::UnknownCustody);
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: vault_ai.clone(),
                    mint: mint_ai.clone(),
                    to: to_ai.clone(),
                    authority: ctx.accounts.pool.to_account_info(),
                },
                signer_seeds,
            ),
            out,
            c.decimals,
        )?;
        book.amounts[i] -= out;
        c.backing_amount = c.backing_amount.saturating_sub(out);
        paid[i] = out;
    }

    let market = &mut ctx.accounts.market;
    let pool = &mut ctx.accounts.pool;
    let in_kind_left = in_kind_weighted(&held(book, &custodies))?;
    book_unback(pool, market, usdc_out, shares, in_kind_left, owed_before)?;

    let no_points = ctx.accounts.pool.no_points;
    let backing = &mut ctx.accounts.backing;
    // The stake is marked to what is left of it, then leaves in proportion to
    // the shares, so a backer who took a loss and left entirely stops earning
    // entirely.
    let cut = basis_cut(backing.points_basis_usd, stake_usd);
    backing.points_basis_usd -= cut;
    let basis_out = ((backing.points_basis_usd as u128) * (shares as u128)
        / (backing.shares as u128)) as u64;
    backing.points_basis_usd -= basis_out;
    backing.shares -= shares;

    let now = Clock::get()?.unix_timestamp;
    let owner = ctx.accounts.owner.key();
    let trader = &mut ctx.accounts.trader;
    open_trader(trader, owner, ctx.bumps.trader, now);
    if !no_points {
        trader.accrue_backing(now)?;
        trader.backing_usd = trader.backing_usd.saturating_sub(cut + basis_out);
    }

    exit_custodies(&custodies)?;
    emit!(BackingWithdrawn {
        market: market.key(),
        owner: backing.owner,
        amount_usd: value_usd,
        usdc: usdc_out,
        in_kind: paid,
        shares,
        backing_usd: market.backing_usd,
        budget_usd: market.loss_budget_usd,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct SyncBacking<'info> {
    #[account(mut, seeds = [POOL_SEED, pool.usdc_mint.as_ref()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,

    #[account(mut, has_one = pool @ PerpError::MarketPoolMismatch)]
    pub market: Box<Account<'info, Market>>,

    #[account(
        mut,
        seeds = [BACKING_BOOK_SEED, market.key().as_ref()],
        bump = book.bump,
        constraint = book.market == market.key() @ PerpError::MarketPoolMismatch,
    )]
    pub book: Box<Account<'info, BackingBook>>,
}

/// Pays the LPs, in kind, for losses they covered past a market's USDC
/// backing, or hands the backers back what a recovery earned. Permissionless:
/// it only ever moves a market's own backing to where the books already say
/// it belongs. `remaining_accounts` as for `back_market`.
pub fn sync_backing<'info>(ctx: Context<'_, '_, 'info, 'info, SyncBacking<'info>>) -> Result<()> {
    let pool_key = ctx.accounts.pool.key();
    let mut custodies = load_custodies(&ctx.accounts.pool, pool_key, ctx.remaining_accounts)?;
    let owed_before = crate::aum::lp_owed_now(&ctx.accounts.market)?;
    sync(
        &mut ctx.accounts.pool,
        &mut ctx.accounts.market,
        &mut ctx.accounts.book,
        &mut custodies,
    )?;
    crate::aum::book_lp_drift(&mut ctx.accounts.pool, &mut ctx.accounts.market, owed_before)?;
    exit_custodies(&custodies)
}

#[derive(Accounts)]
pub struct MarkBacking<'info> {
    #[account(seeds = [POOL_SEED, pool.usdc_mint.as_ref()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,

    #[account(has_one = pool @ PerpError::MarketPoolMismatch)]
    pub market: Box<Account<'info, Market>>,

    /// Absent for a market backed only in USDC before custodies existed.
    #[account(
        seeds = [BACKING_BOOK_SEED, market.key().as_ref()],
        bump = book.bump,
        constraint = book.market == market.key() @ PerpError::MarketPoolMismatch,
    )]
    pub book: Option<Box<Account<'info, BackingBook>>>,

    #[account(
        mut,
        seeds = [BACKING_SEED, market.key().as_ref(), backing.owner.as_ref()],
        bump = backing.bump,
    )]
    pub backing: Box<Account<'info, Backing>>,

    #[account(mut, seeds = [TRADER_SEED, backing.owner.as_ref()], bump = trader.bump)]
    pub trader: Box<Account<'info, Trader>>,
}

/// Marks one backer's points stake down to what their shares are still
/// worth. Permissionless: it only ever lowers a stake, and only to what the
/// market's losses have left of it, so a backer whose pot was drawn to
/// nothing stops earning backing points without having to come back.
/// `remaining_accounts` as for `back_market`.
pub fn mark_backing<'info>(ctx: Context<'_, '_, 'info, 'info, MarkBacking<'info>>) -> Result<()> {
    let pool_key = ctx.accounts.pool.key();
    let custodies = load_custodies(&ctx.accounts.pool, pool_key, ctx.remaining_accounts)?;
    let market = &ctx.accounts.market;
    let in_kind = match &ctx.accounts.book {
        Some(book) => in_kind_value(&held(book, &custodies))?,
        None => 0,
    };
    let pot_usd = market
        .backing_usd
        .checked_add(in_kind)
        .ok_or(PerpError::MathOverflow)?;
    let stake_usd = if market.backing_shares == 0 {
        0
    } else {
        ((pot_usd as u128) * (ctx.accounts.backing.shares as u128)
            / (market.backing_shares as u128)) as u64
    };
    let backing = &mut ctx.accounts.backing;
    let cut = basis_cut(backing.points_basis_usd, stake_usd);
    if cut == 0 {
        return Ok(());
    }
    backing.points_basis_usd -= cut;
    let trader = &mut ctx.accounts.trader;
    trader.accrue_backing(Clock::get()?.unix_timestamp)?;
    trader.backing_usd = trader.backing_usd.saturating_sub(cut);
    emit!(BackingMarked {
        market: market.key(),
        owner: backing.owner,
        cut_usd: cut,
        basis_usd: backing.points_basis_usd,
    });
    Ok(())
}

#[event]
pub struct BackingMarked {
    pub market: Pubkey,
    pub owner: Pubkey,
    pub cut_usd: u64,
    pub basis_usd: u64,
}

#[event]
pub struct MarketBacked {
    pub market: Pubkey,
    pub owner: Pubkey,
    pub mint: Pubkey,
    /// In the deposit token's base units.
    pub amount: u64,
    pub amount_usd: u64,
    pub shares: u64,
    pub backing_usd: u64,
    pub budget_usd: u64,
}

#[event]
pub struct BackingWithdrawn {
    pub market: Pubkey,
    pub owner: Pubkey,
    pub amount_usd: u64,
    pub usdc: u64,
    /// Base units paid back from each custody, by index.
    pub in_kind: [u64; MAX_CUSTODIES],
    pub shares: u64,
    pub backing_usd: u64,
    pub budget_usd: u64,
}

#[event]
pub struct BackingPaidLps {
    pub market: Pubkey,
    pub amount_usd: u64,
    pub taken: [u64; MAX_CUSTODIES],
}

#[event]
pub struct BackingRefunded {
    pub market: Pubkey,
    pub amount_usd: u64,
}

/// In-kind backing repaid the insurance fund for this market's losses:
/// tokens worth `in_kind_usd` (`taken`, by custody) moved to the fund, and
/// `usdc_usd` came out of LP liquidity, from tokens the LPs had been handed
/// for a loss a gain has since repaid them.
#[event]
pub struct BackingRepaidFund {
    pub market: Pubkey,
    pub in_kind_usd: u64,
    pub taken: [u64; MAX_CUSTODIES],
    pub usdc_usd: u64,
}

/// The LPs bought `amount` of the fund's tokens for `usd` of liquidity, at
/// the oracle.
#[event]
pub struct FundTokensSoldToLps {
    pub mint: Pubkey,
    pub amount: u64,
    pub usd: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    const K: u64 = 1_000_000_000; // $1,000

    fn book() -> BackingBook {
        BackingBook {
            bump: 0,
            market: Pubkey::default(),
            amounts: [0; MAX_CUSTODIES],
            reimbursed_usd: 0,
            baseline_usd: 0,
            fund_reimbursed_usd: 0,
            _reserved: [0; 24],
        }
    }

    #[test]
    fn a_refund_into_a_pot_nobody_holds_is_not_made() {
        // Earlier backers' tokens paid the LPs $10k, then every backer left.
        // The market has since won it back. Refunding now would put $10k in
        // a pot with no shares, and the next deposit of one unit would buy
        // all of it.
        let mut pool = crate::instructions::trade::tests::pool();
        pool.liquidity_usd = 100 * K;
        let mut m = crate::instructions::trade::tests::market();
        m.backing_shares = 0;
        m.backing_usd = 0;
        m.net_loss_usd = 0;
        let mut b = book();
        b.reimbursed_usd = 10 * K;
        sync(&mut pool, &mut m, &mut b, &mut []).unwrap();
        assert_eq!(m.backing_usd, 0);
        assert_eq!(pool.liquidity_usd, 100 * K);

        // With a backer still in, the refund is theirs.
        m.backing_shares = 1;
        sync(&mut pool, &mut m, &mut b, &mut []).unwrap();
        assert_eq!(m.backing_usd, 10 * K);
    }

    #[test]
    fn a_sync_repays_the_fund_out_of_what_the_lps_hold_for_it() {
        // The LPs were paid $50 in kind for a loss of their own; the fund has
        // since paid $100 and a gain to the LPs brought the loss past the
        // USDC down to $90. The LPs hold $50 they no longer bore; the fund is
        // owed first, so it goes there.
        let mut pool = crate::instructions::trade::tests::pool();
        pool.liquidity_usd = 1_000 * K;
        pool.insurance_usd = 0;
        let mut m = crate::instructions::trade::tests::market();
        m.backing_shares = 1;
        m.net_loss_usd = 90 * K as i64;
        m.insurance_drawn_usd = 100 * K;
        let mut b = book();
        b.reimbursed_usd = 50 * K;
        sync(&mut pool, &mut m, &mut b, &mut []).unwrap();
        assert_eq!(pool.insurance_usd, 50 * K);
        assert_eq!(pool.liquidity_usd, 950 * K);
        assert_eq!(m.insurance_drawn_usd, 50 * K);
        assert_eq!((b.reimbursed_usd, b.fund_reimbursed_usd), (50 * K, 50 * K));
        // Again: nothing more to move.
        sync(&mut pool, &mut m, &mut b, &mut []).unwrap();
        assert_eq!((pool.insurance_usd, m.insurance_drawn_usd), (50 * K, 50 * K));

        // The market wins it all back. The backers are refunded the whole
        // $50, the fund's part included: the LPs had the gain.
        m.net_loss_usd = 0;
        sync(&mut pool, &mut m, &mut b, &mut []).unwrap();
        assert_eq!((b.reimbursed_usd, b.fund_reimbursed_usd), (0, 0));
        assert_eq!(m.backing_usd, 50 * K);
        assert_eq!(pool.insurance_usd, 50 * K, "the fund keeps what it was repaid");
        assert_eq!(m.insurance_drawn_usd, 50 * K, "and is still owed the rest");
    }

    #[test]
    fn a_deposit_raises_the_budget_by_what_it_posts_and_no_further() {
        // Backers posted $50k; the pool's depth cut the budget to $40k; fees
        // have since added $5k to the pot. One more unit of backing raises
        // the budget by that unit, not back to the $55k pot.
        assert_eq!(raised_budget(40 * K, 55 * K + 1, 1), 40 * K + 1);
        // A real deposit raises it by what it counts for.
        assert_eq!(raised_budget(40 * K, 65 * K, 10 * K), 50 * K);
        // Never past what stands behind the market.
        assert_eq!(raised_budget(40 * K, 45 * K, 10 * K), 45 * K);
        // A first deposit into an unfunded market sets it to that deposit.
        assert_eq!(raised_budget(0, 10 * K, 10 * K), 10 * K);
        // And a budget above the cover is left where it is.
        assert_eq!(raised_budget(100 * K, 20 * K, 10 * K), 100 * K);
    }

    #[test]
    fn a_new_backer_takes_no_part_of_an_earlier_draw_being_repaid() {
        // A backs $100k. Losses draw $90k. B backs $10k into the $10k left,
        // a liquidation then repays the $90k, and B leaves at once. B must
        // leave with the $10k they posted, not half of A's repayment.
        let mut m = crate::instructions::trade::tests::market();
        m.backing_usd = 100 * K;
        m.backing_shares = 100 * K;
        assert_eq!(m.draw_backing(90 * K), 90 * K);
        let b = book();
        let pot = entry_pot_usd(m.backing_usd, m.backing_drawn_usd, b.reimbursed_usd).unwrap();
        let shares = shares_for(10 * K, m.backing_shares, pot).unwrap();
        m.backing_usd += 10 * K;
        m.backing_shares += shares;
        assert_eq!(m.restore_backing(90 * K), 90 * K);
        assert!(m.backing_value(shares) <= 10 * K, "B took {}", m.backing_value(shares));
        assert_eq!(m.backing_value(100 * K), 100 * K, "A is made whole");

        // Leaving $1 in the pot changes nothing.
        let mut m = crate::instructions::trade::tests::market();
        m.backing_usd = 100 * K;
        m.backing_shares = 100 * K;
        m.draw_backing(100 * K - 1_000_000);
        let pot = entry_pot_usd(m.backing_usd, m.backing_drawn_usd, 0).unwrap();
        let shares = shares_for(10 * K, m.backing_shares, pot).unwrap();
        m.backing_usd += 10 * K;
        m.backing_shares += shares;
        m.restore_backing(100 * K);
        assert!(m.backing_value(shares) <= 10 * K);

        // In kind the same: what the tokens paid the LPs is a claim too.
        assert_eq!(entry_pot_usd(10 * K, 30 * K, 50 * K).unwrap(), 90 * K);
    }

    #[test]
    fn withdrawing_one_share_after_a_draw_leaves_the_budget_the_backing_left() {
        // $50k posted, budget $50k. Winners take $30k out of the backing.
        let mut m = crate::instructions::trade::tests::market();
        m.backing_usd = 50 * K;
        m.backing_shares = 50 * K;
        m.loss_budget_usd = 50 * K;
        assert_eq!(m.draw_backing(30 * K), 30 * K);
        m.charge_loss(30 * K).unwrap();
        assert_eq!(m.remaining_budget_usd(), 20 * K);

        // One unit out: the budget follows the money down by one unit, not
        // to zero.
        m.backing_usd -= 1;
        m.backing_shares -= 1;
        m.loss_budget_usd = m.loss_budget_usd.min(budget_cap(m.backing_usd, m.net_loss_usd));
        assert_eq!(m.remaining_budget_usd(), m.backing_usd);
        assert_eq!(m.remaining_budget_usd(), 20 * K - 1);

        // $10k in: the remaining budget rises by the $10k.
        m.backing_usd += 10 * K;
        m.loss_budget_usd = raised_budget(
            m.loss_budget_usd,
            budget_cap(m.backing_usd, m.net_loss_usd),
            10 * K,
        );
        assert_eq!(m.remaining_budget_usd(), 30 * K - 1);

        // A pool that is up counts nothing spent.
        assert_eq!(budget_cap(5 * K, -3 * K as i64), 5 * K);
    }

    #[test]
    fn a_backer_leaving_ahead_of_a_visible_loss_leaves_it_behind() {
        // $50k pot, longs $20k up at the mark: half the shares take half of
        // the $30k the winners have not already claimed.
        assert_eq!(exit_part(50 * K, 25 * K, 50 * K, 50 * K, 20 * K), 15 * K);
        // Nothing owed: the whole part.
        assert_eq!(exit_part(50 * K, 25 * K, 50 * K, 50 * K, 0), 25 * K);
        // Owed past the pot: nothing comes out.
        assert_eq!(exit_part(50 * K, 25 * K, 50 * K, 50 * K, 80 * K), 0);

        // What the market's traders are up, as the backing would pay it.
        let mut m = crate::instructions::trade::tests::market();
        m.backing_usd = 50 * K;
        m.loss_budget_usd = 50 * K;
        m.long_size_usd = 100 * K;
        m.long_avg_entry_price = 100_000_000;
        m.short_size_usd = 0;
        let up = m.trader_pnl_usd(120_000_000).unwrap();
        assert_eq!(m.backing_owed_usd(120_000_000).unwrap(), up as u64);
        // Never past what the budget would pay.
        m.loss_budget_usd = 5 * K;
        assert_eq!(m.backing_owed_usd(120_000_000).unwrap(), 5 * K);
        // Traders down owe the backing nothing here.
        assert_eq!(m.backing_owed_usd(80_000_000).unwrap(), 0);
    }

    #[test]
    fn a_checkpoint_taken_before_a_withdrawal_sees_it() {
        // Back -> checkpoint -> unback -> claim. $10k of backing drawn on for
        // $30k; $100k of longs from $100 now at $80, $20k down. While the
        // backers hold shares that $20k is theirs to get back, so the LPs are
        // owed nothing from it. The checkpoint counts that. Then every backer
        // leaves: the $20k is the LPs' now, and a claim or a deposit reading
        // the checkpoint must see it.
        const NOW: i64 = 1_000_000;
        let mut p = crate::instructions::trade::tests::pool();
        p.liquidity_usd = 1_000 * K;
        p.backing_usd = 10 * K;
        let mut m = crate::instructions::trade::tests::market();
        m.backing_usd = 10 * K;
        m.backing_shares = 10 * K;
        m.backing_drawn_usd = 30 * K;
        m.long_size_usd = 100 * K;
        m.long_avg_entry_price = 100_000_000;
        m.collateral_usd = 30 * K;
        m.last_price = 80_000_000;
        let price = m.last_price;
        assert_eq!(m.lp_pnl_usd(price).unwrap(), 0);

        let pool_key = Pubkey::new_unique();
        let counted = m.lp_pnl_usd(price).unwrap().wrapping_sub(m.aum_drift_usd);
        let c = AumCheckpoint {
            pool: pool_key, bump: 0,
            pass_open: false, pass_started_ts: NOW, pass_version: p.oi_version,
            pass_markets: p.markets_with_oi, pass_counted: p.markets_with_oi,
            pass_last_market: Pubkey::default(),
            pass_pnl_usd: counted, pass_claim_pnl_usd: counted, pass_unpriced: 0,
            done_ts: NOW, done_version: p.oi_version, done_markets: p.markets_with_oi,
            done_pnl_usd: counted, done_claim_pnl_usd: counted, done_unpriced: 0,
            pass_at_best: true, done_at_best: true, _reserved: [0; 10],
        };

        let owed_before = crate::aum::lp_owed_now(&m).unwrap();
        book_unback(&mut p, &mut m, 10 * K, 10 * K, 0, owed_before).unwrap();
        let truth = m.lp_pnl_usd(price).unwrap();
        assert_eq!(truth, -20 * K as i64, "the $20k is the LPs' now");
        for side in [crate::aum::Unpriced::AtBest, crate::aum::Unpriced::AtWorst] {
            let read = crate::aum::checkpoint_pnl_usd(
                pool_key, p.oi_version, p.markets_with_oi, p.aum_drift_usd, &c, NOW, side,
            )
            .unwrap();
            assert_eq!(read, truth, "{side:?}");
        }
    }

    #[test]
    fn a_drained_stake_stops_earning_backing_points() {
        // $100k posted, the pot drawn to nothing: the whole basis goes.
        assert_eq!(basis_cut(100 * K, 0), 100 * K);
        // Half the pot left: half the basis.
        assert_eq!(basis_cut(100 * K, 50 * K), 50 * K);
        // A stake worth more than was posted keeps its basis.
        assert_eq!(basis_cut(100 * K, 120 * K), 0);
    }

    // ---- What a leaver leaves behind, and the custody list ----

    #[test]
    fn a_failed_price_counts_at_worst_only_when_it_is_unusable() {
        for e in [PerpError::StaleOracle, PerpError::OracleConfidenceTooWide, PerpError::OracleNotSeasoned] {
            assert!(price_unusable(&e.into()), "{e:?}");
        }
        for e in [PerpError::WrongOracleFeed, PerpError::WrongOracleOwner, PerpError::MathOverflow] {
            assert!(!price_unusable(&e.into()), "{e:?}");
        }
        assert!(!price_unusable(&ProgramError::InvalidAccountData.into()));
    }

    /// A market with $10k of longs from $100 and a $5k budget left.
    fn long_book() -> Market {
        let mut m = crate::instructions::trade::tests::market();
        m.long_size_usd = 10 * K;
        m.long_avg_entry_price = 100_000_000;
        m.loss_budget_usd = 5 * K;
        m.net_loss_usd = 0;
        m.risk_price = 0;
        m
    }

    #[test]
    fn nothing_is_held_back_for_a_market_with_nothing_open() {
        let m = crate::instructions::trade::tests::market();
        assert_eq!(held_back_usd(&m, Ok(200_000_000), 50 * K).unwrap(), 0);
        // Not even a price is needed.
        assert_eq!(held_back_usd(&m, Err(PerpError::WrongOracleFeed.into()), 50 * K).unwrap(), 0);
    }

    #[test]
    fn what_traders_are_up_is_held_back_at_the_worse_of_the_two_prices() {
        let mut m = long_book();
        // At $110 the longs are up $1k.
        assert_eq!(held_back_usd(&m, Ok(110_000_000), 50 * K).unwrap(), K);
        // A lagging risk price above the oracle holds back more.
        m.risk_price = 120_000_000;
        assert_eq!(held_back_usd(&m, Ok(110_000_000), 50 * K).unwrap(), 2 * K);
        // Below it, the oracle's figure stands.
        m.risk_price = 105_000_000;
        assert_eq!(held_back_usd(&m, Ok(110_000_000), 50 * K).unwrap(), K);
        // Traders down hold back nothing.
        m.risk_price = 0;
        assert_eq!(held_back_usd(&m, Ok(90_000_000), 50 * K).unwrap(), 0);
    }

    #[test]
    fn held_back_is_capped_by_the_budget_and_the_pot() {
        let m = long_book();
        // Up $10k at $200, but the budget pays at most $5k.
        assert_eq!(held_back_usd(&m, Ok(200_000_000), 50 * K).unwrap(), 5 * K);
        // And never more than the pot holds.
        assert_eq!(held_back_usd(&m, Ok(200_000_000), 3 * K).unwrap(), 3 * K);
    }

    #[test]
    fn an_unusable_price_holds_back_the_whole_budget_and_a_wrong_one_fails() {
        let m = long_book();
        assert_eq!(held_back_usd(&m, Err(PerpError::StaleOracle.into()), 50 * K).unwrap(), 5 * K);
        assert_eq!(held_back_usd(&m, Err(PerpError::OracleNotSeasoned.into()), 2 * K).unwrap(), 2 * K);
        assert_eq!(
            held_back_usd(&m, Err(PerpError::WrongOracleOwner.into()), 50 * K).unwrap_err(),
            PerpError::WrongOracleOwner.into()
        );
    }

    #[test]
    fn an_empty_pot_or_share_count_pays_nobody_on_exit() {
        assert_eq!(exit_part(50 * K, 25 * K, 0, 50 * K, 0), 0);
        assert_eq!(exit_part(50 * K, 25 * K, 50 * K, 0, 0), 0);
        // All the shares, nothing held back: everything.
        assert_eq!(exit_part(u64::MAX, 7, 7, u64::MAX, 0), u64::MAX);
    }

    #[test]
    fn an_entry_pot_past_u64_is_refused() {
        assert_eq!(entry_pot_usd(u64::MAX, 1, 0).unwrap_err(), PerpError::MathOverflow.into());
        assert_eq!(entry_pot_usd(u64::MAX - 1, 1, 1).unwrap_err(), PerpError::MathOverflow.into());
    }

    #[test]
    fn a_raised_budget_never_falls_and_never_passes_the_cover() {
        assert_eq!(raised_budget(5 * K, 3 * K, 10 * K), 5 * K, "never lowered");
        assert_eq!(raised_budget(5 * K, u64::MAX, u64::MAX), u64::MAX, "saturates");
        assert_eq!(budget_cap(u64::MAX, i64::MAX), u64::MAX);
    }

    fn leak<T>(x: T) -> &'static mut T {
        Box::leak(Box::new(x))
    }

    fn info(key: Pubkey, owner: Pubkey, data: Vec<u8>) -> &'static AccountInfo<'static> {
        leak(AccountInfo::new(leak(key), false, true, leak(0u64), Box::leak(data.into_boxed_slice()), leak(owner), false, 0))
    }

    fn custody(pool: Pubkey, index: u8, is_stable: bool) -> Custody {
        Custody {
            bump: 0, vault_bump: 0, pool,
            mint: Pubkey::default(), vault: Pubkey::default(),
            decimals: 6, index, is_stable,
            feed_id: [0; 32], max_price_age_sec: 0, max_conf_bps: 0,
            budget_weight_bps: 10_000,
            backing_amount: 0, lp_amount: 0, lp_owed_amount: 0, insurance_amount: 0,
            _reserved: [0; 16],
        }
    }

    fn custody_pairs(cs: &[Custody]) -> &'static [AccountInfo<'static>] {
        let mut v = Vec::new();
        for c in cs {
            let mut d = Vec::new();
            c.try_serialize(&mut d).unwrap();
            v.push(info(Pubkey::new_unique(), crate::ID, d).clone());
            // A stable is priced at $1 without reading its feed.
            v.push(info(Pubkey::new_unique(), Pubkey::default(), vec![]).clone());
        }
        Box::leak(v.into_boxed_slice())
    }

    #[test]
    fn every_custody_must_be_listed_in_order_and_of_this_pool() {
        let key = Pubkey::new_unique();
        let mut p = crate::instructions::trade::tests::pool();
        p.num_custodies = 2;
        let both = custody_pairs(&[custody(key, 0, true), custody(key, 1, true)]);
        let got = load_custodies(&p, key, both).unwrap();
        assert_eq!(got.len(), 2);
        assert!(got.iter().all(|(_, price)| *price == PRICE_SCALE as u64));
        // One short.
        assert_eq!(load_custodies(&p, key, &both[..2]).err().unwrap(), PerpError::IncompleteCustodyList.into());
        // Out of order.
        let swapped = custody_pairs(&[custody(key, 1, true), custody(key, 0, true)]);
        assert_eq!(load_custodies(&p, key, swapped).err().unwrap(), PerpError::IncompleteCustodyList.into());
        // Another pool's.
        let foreign = custody_pairs(&[custody(key, 0, true), custody(Pubkey::new_unique(), 1, true)]);
        assert_eq!(load_custodies(&p, key, foreign).err().unwrap(), PerpError::MarketPoolMismatch.into());
    }

    #[test]
    fn a_sync_moves_tokens_the_lps_are_owed_out_of_the_book_into_their_custody() {
        let key = Pubkey::new_unique();
        let mut pool = crate::instructions::trade::tests::pool();
        pool.num_custodies = 1;
        let pairs = custody_pairs(&[custody(key, 0, true)]);
        let mut cs = load_custodies(&pool, key, pairs).unwrap();
        cs[0].0.backing_amount = 10 * K;
        let mut m = crate::instructions::trade::tests::market();
        // The LPs have paid a $3k loss past the USDC backing.
        m.net_loss_usd = 3 * K as i64;
        m.backing_drawn_usd = 0;
        m.backing_usd = 0;
        let mut b = book();
        b.amounts[0] = 10 * K; // $10k of a $1 stable
        sync(&mut pool, &mut m, &mut b, &mut cs).unwrap();
        assert_eq!(b.amounts[0], 7 * K);
        assert_eq!(b.reimbursed_usd, 3 * K);
        assert_eq!((cs[0].0.backing_amount, cs[0].0.lp_amount), (7 * K, 3 * K));
        // The budget is held to what stands behind the market now.
        assert!(m.remaining_budget_usd() <= 7 * K);
        // Run again, nothing more is owed.
        sync(&mut pool, &mut m, &mut b, &mut cs).unwrap();
        assert_eq!(b.amounts[0], 7 * K);
    }
}
