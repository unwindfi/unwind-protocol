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
    let plan = plan_sync(
        lp_borne_usd(market.net_loss_usd, market.backing_drawn_usd),
        book.baseline_usd,
        book.reimbursed_usd,
        &held(book, custodies),
        pool.free_liquidity_usd(),
    )?;
    match plan {
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
        Sync::Refund { usd } => {
            pool.liquidity_usd -= usd;
            pool.backing_usd = pool.backing_usd.checked_add(usd).ok_or(PerpError::MathOverflow)?;
            market.backing_usd = market
                .backing_usd
                .checked_add(usd)
                .ok_or(PerpError::MathOverflow)?;
            book.reimbursed_usd -= usd;
            emit!(BackingRefunded { market: book.market, amount_usd: usd });
        }
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
        market.loss_budget_usd = market.loss_budget_usd.min(cover);
    }
    Ok(())
}

fn exit_custodies(custodies: &[(Account<Custody>, u64)]) -> Result<()> {
    for (c, _) in custodies {
        c.exit(&crate::ID)?;
    }
    Ok(())
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
/// The budget is set from the backing rather than added to, so it can never
/// drift above what stands behind it. A market the authority had already
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

    let shares = shares_for(amount_usd, ctx.accounts.market.backing_shares, pot_usd)?;
    require!(shares > 0, PerpError::ZeroAmount);

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
    market.loss_budget_usd = market.loss_budget_usd.max(cover);

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
    backing.points_basis_usd = backing
        .points_basis_usd
        .checked_add(amount_usd)
        .ok_or(PerpError::MathOverflow)?;

    // Points up to now at the old stake, then the stake grows.
    let now = Clock::get()?.unix_timestamp;
    let owner = ctx.accounts.owner.key();
    let trader = &mut ctx.accounts.trader;
    open_trader(trader, owner, ctx.bumps.trader, now);
    trader.accrue_backing(now)?;
    trader.backing_usd = trader
        .backing_usd
        .checked_add(amount_usd)
        .ok_or(PerpError::MathOverflow)?;

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
    sync(&mut ctx.accounts.pool, &mut ctx.accounts.market, book, &mut custodies)?;

    let total = ctx.accounts.market.backing_shares;
    require!(total > 0, PerpError::ZeroAmount);
    let part = |x: u64| ((x as u128) * (shares as u128) / (total as u128)) as u64;

    let h = held(book, &custodies);
    let pot_usd = ctx
        .accounts
        .market
        .backing_usd
        .checked_add(in_kind_value(&h)?)
        .ok_or(PerpError::MathOverflow)?;
    let value_usd = part(pot_usd);
    require!(value_usd > 0, PerpError::ZeroAmount);

    // What the market would be left with has to cover what its open positions
    // have reserved, and what they are already up at the current price. The
    // reserve alone let a backer who saw the market move against the pool
    // leave first, shrinking the budget before the winners closed and handing
    // their loss to the LPs.
    //
    // No price is read for a market with nobody in it, so the backers of a
    // market whose source has died can still get their money out.
    let owed_usd = if ctx.accounts.market.has_open_interest() {
        let market_key = ctx.accounts.market.key();
        let oracle = market_price(
            &ctx.accounts.price_update.to_account_info(),
            &ctx.accounts.pool,
            &ctx.accounts.market,
            &market_key,
        )?;
        ctx.accounts.market.accept_price(&oracle)?;
        ctx.accounts.market.trader_pnl_usd(oracle.price)?.max(0) as u64
    } else {
        0
    };
    require!(
        pot_usd.saturating_sub(value_usd) >= ctx.accounts.market.locked_usd.max(owed_usd),
        PerpError::InsufficientLiquidity
    );

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
    market.backing_usd -= usdc_out;
    market.backing_shares -= shares;
    // The budget follows the money down. A market whose backers have left is
    // a market that may not open new exposure, which is the same state it was
    // in before anyone backed it.
    let cover = market
        .backing_usd
        .checked_add(in_kind_weighted(&held(book, &custodies))?)
        .ok_or(PerpError::MathOverflow)?;
    market.loss_budget_usd = market.loss_budget_usd.min(cover);

    let pool = &mut ctx.accounts.pool;
    pool.backing_usd = pool.backing_usd.saturating_sub(usdc_out);

    let backing = &mut ctx.accounts.backing;
    // The stake leaves in proportion to the shares, whatever they were worth,
    // so a backer who took a loss and left entirely stops earning entirely.
    let basis_out = ((backing.points_basis_usd as u128) * (shares as u128)
        / (backing.shares as u128)) as u64;
    backing.points_basis_usd -= basis_out;
    backing.shares -= shares;

    let now = Clock::get()?.unix_timestamp;
    let owner = ctx.accounts.owner.key();
    let trader = &mut ctx.accounts.trader;
    open_trader(trader, owner, ctx.bumps.trader, now);
    trader.accrue_backing(now)?;
    trader.backing_usd = trader.backing_usd.saturating_sub(basis_out);

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
    sync(
        &mut ctx.accounts.pool,
        &mut ctx.accounts.market,
        &mut ctx.accounts.book,
        &mut custodies,
    )?;
    exit_custodies(&custodies)
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
