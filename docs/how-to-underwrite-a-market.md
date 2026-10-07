# How to underwrite a market

## Overview

A market takes no position until it has a loss budget. That budget is
collateral somebody posts, not an allowance an administrator grants. Posting
it is underwriting, or backing. Any account can back any market that is not
paused. A paused market takes no new backing, and the Back tab leaves it off.

Backing stands in front of the liquidity pool on the market's losses, and is
paid in front of the pool on the market's fees.

## Backing or the pool

| | Backing a market | Depositing in the pool |
| --- | --- | --- |
| Exposure | One market's losses, first | Every market's losses past their backing, up to each budget |
| Fees | Half the LPs' share of that market's fees: 30% of every fee on the default split | The rest of the LPs' share, across all markets |
| Points | 2 per $1 per day | 1 per $1 per day |
| Deposit in | USDC, USDT or SOL | USDC |
| Withdraw | One transaction, at any time | Request, wait 150 slots (about a minute), claim at the value then |
| Paid back in | The pot's own mix of tokens | USDC plus the same share of any tokens the LPs hold |

Both show in the portfolio in their own cards, apart from trading positions
(see [Portfolio](portfolio.md)). The pool's rules are on
[The pool](pool.md).

## What a backer takes on

1. **Losses first.** A market's losses are drawn from its backing before they
   reach the pool.
2. **Gains only up to what was drawn.** When the market recovers, gains go
   back to the backing up to what losses took from it, and no further.
   Backing is not a leveraged claim on the pool's profits.
3. **Tokens pay after the USDC.** Settlement pays in USDC, so backing posted
   in USDT or SOL pays once the USDC backing is gone: it repays the
   insurance fund first, then the LPs, for what they covered. See
   [Loss budget](loss-budget.md#backing-held-in-tokens).

## Backing a market that has been drawn on

What a later gain puts back belongs to the backers it was drawn from. So a
new share is priced against the pot plus what the market still owes back to
it, in USDC and in kind. The new backer pays for their part of that
repayment at face.

Example:

1. Backers post $100,000. Losses draw $90,000. The pot holds $10,000 and
   $90,000 is owed back.
2. A new backer posts $10,000 and gets 10,000 shares against the original
   100,000. Not 100,000.
3. A gain repays the $90,000. The pot holds $110,000: the new backer can take
   out $10,000, the original backers $100,000.

Priced against the $10,000 pot alone, the new backer would have bought half
the shares and taken $55,000.

A backer who withdraws takes their part of the pot and leaves their part of
what is owed back to the backers who stay. In and straight back out never
profits.

| State of the pot | New backing |
| --- | --- |
| Empty, no shares | First backer gets one share per dollar |
| Drawn down, shares held, something owed back | Priced against pot plus what is owed back |
| Worth nothing, nothing owed back, shares still held | Refused |
| Every backer has left | Starts clean. Later gains stay with the pool, and the new backer has no claim on losses before they arrived. |

## What a backer earns

**Fees.** Backers of a market take half of the pool's share of that
market's trading fees. The cut is taken after the protocol (20%), chain (10%)
and insurance (10%) shares, so on a backed market it is 30% of every fee. See
[Fees](fees.md).

The fee is not paid to an account. It is credited to the market's backing,
so every share is worth more and the income compounds until the backer
withdraws. It does not raise the market's loss budget: fee income belongs to
the backers, and letting it widen the allowance would let a busy market
underwrite itself with money nobody chose to put at risk.

**Points.** 2 points per $1 of backing per day (see
[Referrals and points](rewards.md)), on what the stake is still worth:

1. Counted on what was posted, in dollars at the time.
2. Cut in proportion to the shares withdrawn.
3. Cut to the stake's value when the market's losses draw on it.
   `mark_backing` does that for any backer; it is permissionless, and the
   server runs it every 10 minutes.
4. Zero in a pool whose points are switched off.

## What backing can be posted in

Backing is held in whatever it was posted in. Nothing is swapped on the way
in. USDC sits in the pool's vault. Every other token sits in a custody of its
own, priced by oracle.

| Token | Counts toward the budget at | Price |
| --- | --- | --- |
| USDC | 100% | |
| USDT | 100% | |
| SOL | 80% | Pyth SOL/USD, at most 90 seconds old, confidence at most 200 bps |

SOL counts at less than its value because first-loss cover held in SOL
shrinks in the crash it exists to absorb. When SOL falls, the budget falls
with it. It does not rise again when SOL recovers; raising a budget takes a
deposit. A deposit raises the budget by what it counts for, never past the
backing behind the market: $1,000 of SOL raises it by $800.

A backing share is a claim on the whole pot behind a market, and it is paid
out in the same mix of tokens the pot holds.

## When a loss reaches past the USDC

Every market settles in USDC. When a loss runs past the USDC behind a market,
the pool covers the difference, and `sync_backing` moves tokens worth the
same amount, at the oracle, from the backers to the LPs. From then on they
count in the pool's assets, and an LP who leaves takes their share of them in
kind. When the market recovers, the same instruction hands the backers back
what the recovery earned. It is permissionless: it only moves a market's
backing to where the books already say it belongs.

## Each vault's page

Every row on Earn opens a page of its own: `/vault/<symbol>` for a market's
backing, `/vault/pool` for the pool. It shows what the vault holds, its APY
and utilization, your share, a chart of value per share (one point every 2
minutes, from `/api/apy?series=1`), and the market it stands behind with that
market's leverage, maintenance margin and budget. Deposit and withdraw from
there or from the row.

## Withdrawing

A backer can withdraw at any time, in one transaction, up to what their
shares are worth after the market's losses, less their part of what the
market's traders are up right now.

1. **What is held back** is what the backing would pay if every open
   position closed now: the traders' profit net across both sides, at the
   oracle or the market's risk price, whichever makes it larger, and never
   more than the pot.
2. **If the price cannot be read,** the whole remaining budget is held.
3. **It stays in the pot** for the backers who stay. They pay it if the loss
   is realized and keep it if the price turns.
4. **A balanced book holds nothing back.** Only the visible loss is held, not
   the positions' size.

Example: a $50,000 pot behind longs that are $20,000 up. A backer with half
the shares can take out $15,000, half of the $30,000 not already owed.

**The budget follows the backing.** Withdrawing lowers the market's
remaining budget so that it is at most the backing left. After $30,000 of
losses against a $50,000 budget and $50,000 of backing, $20,000 remains of
each, and withdrawing $1 leaves $19,999 of both. A new deposit raises the
remaining budget by what it counts for. Winners are paid only out of the
remaining budget, at a fair share when it falls short (see
[Profit haircuts](auto-deleveraging.md)).

## Why anyone would do it

Somebody who wants a market to exist shows it with their own capital, not
the LPs', and is paid for carrying the first loss.

1. **No grants.** An allowance granted by the pool authority would make
   listing permissionless in name only: every new market would still wait
   on the authority.
2. **LPs sit behind the backer,** not in front.
3. **Brake only.** The authority can lower a market's budget with
   `set_market_budget`. It cannot raise one.
