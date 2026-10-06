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

## Backing a market that has been drawn on

What a gain puts back into the backing belongs to the backers it was drawn
from. So a new share is priced against the pot plus what the market still
owes back to it, in USDC and in kind, and the new backer pays for their part
of that repayment at face.

Example: backers post $100,000 and losses draw $90,000. The pot holds $10,000
and $90,000 is owed back. A new backer posting $10,000 gets 10,000 shares
against the original 100,000, not 100,000. If a gain then repays the $90,000,
the pot holds $110,000: the new backer can take out $10,000 and the original
backers $100,000. Priced against the $10,000 pot alone, the new backer would
have taken $55,000 of it.

A backer who withdraws takes their part of the pot and leaves their part of
what is owed back to the backers who stay. Going in and straight back out
never profits.

If a market's losses draw its backing all the way to zero while its backers
still hold their shares, new backing is priced the same way, against what is
owed back. A pot with nothing in it and nothing owed back, with shares still
held, refuses new backing.

If every backer has withdrawn, nothing is restored to the backing: later gains
stay with the liquidity pool, as backers' fees do in the same case. The next
backer starts clean, with no claim on losses taken before they arrived.

## What a backer earns

Backers of a market take half of the liquidity pool's share of that market's
trading fees. The cut is taken after the protocol, chain and insurance shares,
so on a backed market it is 30 percent of every fee. See [Fees](fees.md).

Backing also earns points (see [Rewards](rewards.md)) on what the stake is
still worth: a stake the market's losses have drawn on stops earning on what
was lost. `mark_backing` brings any backer's stake down to that figure.
It is permissionless, and the server runs it for every backer every ten
minutes.

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
money to do. A deposit raises it by what that deposit counts for, never past
the backing behind the market: $1,000 of SOL at 80 percent raises it by $800.

A backing share is a claim on the whole pot behind a market, and it is paid
back out in the same mix of tokens the pot holds.

## When a loss reaches past the USDC

Every market settles in USDC. When a loss runs past the USDC behind a market,
the liquidity pool covers the difference, and `sync_backing` then moves tokens
worth the same amount, at the oracle, from the backers to the pool. From then
on they count in the pool's assets, and an LP who leaves takes their part of
them in kind (see [The pool](pool.md)). When a market recovers, the same
instruction hands the backers back what the recovery earned. It is
permissionless, since it only moves a market's backing to where the books
already say it belongs.

## Each vault's page

Every row on Earn opens a page of its own (`/vault?id=<symbol>`, or
`pool`): what it holds, its APY and utilisation, your share, a chart of its
value per share from the server's tape (one point every two minutes, served
by `/api/apy?series=1`), and the market it stands behind with that market's
leverage, maintenance margin and budget. Deposit and withdraw from there or
from the row.

## Withdrawing

A backer may withdraw their stake at any time, bounded by what their shares
are worth after the market's losses, less their part of what the market's
traders are up right now.

That second part is what the backing would pay if every open position closed
at the current price: the traders' profit net across both sides, at the
oracle or the market's risk price, whichever is more, and never more than the
remaining budget. If the price cannot be read, the whole remaining budget is
held. It stays in the pot for the backers who stay, who pay it if the loss is
realised and keep it if the price turns. Only the visible loss is held, not
the positions' full size, so a balanced book holds nothing back.

Example: a $50,000 pot behind longs that are $20,000 up. A backer with half
the shares can take out $15,000, half of the $30,000 not already owed.

Withdrawing lowers the market's loss budget so that what is left of it is at
most the backing that is left. After losses of $30,000 against a $50,000
budget and $50,000 of backing, $20,000 remains of each, and withdrawing $1
leaves $19,999 of both. A new deposit raises what remains by what it counts
for. Winners are only ever paid out of the remaining budget, at a fair share
when it falls short (see [Profit haircuts](auto-deleveraging.md)).

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

The authority can lower a market's budget with `set_market_budget`, as a
brake on a market it no longer trusts. It cannot raise one.
