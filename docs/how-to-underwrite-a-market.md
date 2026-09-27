# How to underwrite a market

## Overview

A market cannot be traded against until it has a loss budget, and that budget
is collateral posted by somebody rather than an allowance granted by an
administrator. Posting it is called underwriting, or backing, and any account
may do it for any market.

Backing stands in front of the liquidity pool on the market's losses, and is
paid in front of the pool on the market's fees.

## What a backer takes on

Losses in a market are drawn from its backing before they reach the liquidity
pool, which places backers ahead of liquidity providers in absorbing them.

Where a market subsequently recovers, gains are returned to the backing only
up to the amount previously drawn from it. Backing does not participate in a
market's trading gains beyond being made whole, which prevents a market from
being used as a leveraged claim on the pool's profits.

## When a market's backing is wiped out

If a market's losses draw its backing all the way to zero while its backers
still hold their shares, the market refuses new backing until a gain restores
some. New money cannot be priced against shares worth nothing: it would either
be shared with those holders or cancel their claim on a later recovery, and
both take from somebody.

If every backer has withdrawn, nothing is restored to the backing: later gains
stay with the liquidity pool, as backers' fees do in the same case. The next
backer starts clean, with no claim on losses taken before they arrived.

## What a backer earns

Backers of a market take half of the liquidity pool's share of that market's
trading fees. The cut is taken after the protocol, chain and insurance shares,
so on a backed market it is 30 percent of every fee. See [Fees](fees.md).

The fee is not paid to an account. It is credited to the market's backing, so
every backing share is worth more and the income compounds until the backer
withdraws. It does not raise the market's loss budget: fee income belongs to
the backers, and letting it widen the allowance would let a busy market
underwrite itself with money nobody chose to put at risk.

## What backing can be posted in

Backing can be posted in USDC, USDT or SOL, and it is held in whatever it was
posted in. Nothing is swapped on the way in. USDC sits in the pool's vault,
and every other token sits in a custody of its own, priced by oracle, the way
Jupiter's JLP pool holds each asset.

| Token | Counts toward the budget at |
| --- | --- |
| USDC | 100 percent |
| USDT | 100 percent |
| SOL | 80 percent |

SOL counts at less than its value because a first loss cushion held in SOL
shrinks in exactly the crash it exists to absorb. When the price of what is
held falls, the market's budget falls with it. It does not rise again by
itself when the price recovers; raising a budget is something somebody posts
money to do.

A backing share is a claim on the whole pot behind a market, and it is paid
back out in the same mix of tokens the pot holds.

## When a loss reaches past the USDC

Every market settles in USDC. When a loss runs past the USDC behind a market,
the liquidity pool covers the difference, and `sync_backing` then moves tokens
worth the same amount, at the oracle, from the backers to the pool. From then
on they count in the pool's assets. When a market recovers, the same
instruction hands the backers back what the recovery earned. It is
permissionless, since it only moves a market's backing to where the books
already say it belongs.

## Withdrawing

A backer may withdraw at any time, bounded twice: by what their shares are
worth after the market's losses, and by what the market still has to cover.
What stays behind must cover both the reserve its open positions have locked
and whatever those positions are already winning at the current price.

The second part is what stops a backer who sees the market move against the
pool from leaving first. Without it, the budget would shrink just before the
winners closed, and their profit would fall on the liquidity providers, who
never underwrote the market. A market with no open positions needs no price to
withdraw from, so backing is never stuck behind a market whose price source
has stopped.

## Why anyone would do it

Underwriting is the mechanism by which somebody who wants a market to exist
demonstrates that conviction with their own capital rather than with the
liquidity providers' capital, and is paid for carrying the first loss.

The design replaced an earlier arrangement in which the pool authority
granted an allowance to each market. That arrangement made listing
permissionless in name only, because every new market still required the
authority to act. Making the allowance collateral rather than permission
removes that step, and is strictly safer for liquidity providers, who now sit
behind the backer rather than in front.

The authority can still set a market's budget directly with
`set_market_budget`. No market needs it to, and no other account can.
