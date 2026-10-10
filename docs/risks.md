# Risks

## Overview

You can lose everything you post as margin. You can lose everything you
deposit as backing or pool liquidity. This page lists where those losses
come from, what the program does about each, and what it does not. Each entry
links to the page with the full rule. Where this page and the program
disagree, the program is right.

Nothing in these docs is investment advice.

## The program

1. **Not audited.** No audit firm has reviewed the program. 126 Kani
   harnesses and the unit and integration tests check the arithmetic and the
   instructions (see [Verification](verification.md)). That is not an audit.
   Account validation, token transfers and whole instructions are tested,
   not proven.
2. **Upgradeable.** The program has an upgrade authority. An upgrade can
   change any rule on these pages.
3. **The pool authority has powers.** It can pause a market or the pool,
   retune a market's parameters (held to consistency checks, not to the
   listing bounds), lower a budget, apply a split or dividend, set a
   session, and name the mark keeper. It cannot raise a budget.

A bug can lose funds that no rule here protects.

## Leverage and liquidation

1. **Leverage is per market.** A market priced from a spot pool follows the
   pool's sustained depth: 2x under $10k, 3x to $50k, 4x to $250k, 5x above.
   It falls on the next reading when the pool thins. A Pyth market the pool
   authority lists can carry more: SPYx allows 20x. Outside US trading
   hours, equity markets drop to a lower closed-session cap. See
   [Margining](margining.md) and [Sessions](sessions.md).
2. **Any account can liquidate.** A position whose equity falls under
   maintenance margin is closed. The trigger is the market's risk price; the
   close is at the worse of the risk price and the oracle. The liquidation
   fee comes out of the position. The owner gets back what is left after the
   fee, which can be nothing.
3. **The risk price moves at most 40 bps a slot,** and counts at most 3
   slots per step: 1.2% per reading after a gap. A spike that comes back
   within a few slots liquidates nobody. A real move gets there a step at a
   time, so positions are closed on the way while they still have margin.
   See [Liquidations](liquidations.md).

## Prices

| Source | What protects it | What does not |
| --- | --- | --- |
| Pyth feed | Only moves forward: a price older than the newest the market used is refused, two prices under one publish time are refused, a publish time more than 5 seconds ahead of the chain is refused. Stale or too-uncertain prices pause orders. | A wrong feed is a wrong mark. |
| Spot pool, keeper mark | The program reads the pool's depth and its price itself, so leverage and budget caps never depend on the keeper, and a pushed mark more than 10% from the pool's own price in the same transaction is refused. The risk price caps how fast a pushed mark reaches liquidations. The keeper holds any move over 10% for one push, then steps 10% a push. | Inside that 10%, the mark is whatever the keeper key pushes. A thin pool can be pushed, and the keeper follows it. |

See [Price sources](price-sources.md).

## Keepers

The venue's server clears batches, pushes keeper marks, runs liquidations
and syncs rewards. If it stops:

1. Batches stop clearing. Orders already in a batch wait.
2. Keeper marks go stale and those markets pause rather than fill at an old
   price.
3. Liquidation, clearing and settlement stay open to any account. Pushing a
   keeper mark does not: only the named keeper key can.

## Where losses go

A market's losses are paid in this order:

1. The backing posted behind it.
2. Pool liquidity, up to the market's loss budget.
3. The insurance fund.

Settlement pays in USDC, so backing posted in tokens pays afterwards: it
repays the fund first, then the LPs. A batch's closes are netted, so the
order anyone settles them in does not change who pays. See
[Loss budget](loss-budget.md#who-pays-a-loss).

A winner is never paid past the budget. When a market cannot pay every
winner, each winning close gets the same share of its profit and the rest is
not paid. A profitable position can be paid less than its paper gain. See
[Loss budget](loss-budget.md) and [Profit haircuts](auto-deleveraging.md).

## Backing

1. **First loss.** Backers take the market's losses before the pool, up to
   everything they posted. Later gains repay them only up to what was drawn.
2. **Exits hold back open losses.** A backer can withdraw at any time, less
   their part of what the market's traders are up now, at the oracle or the
   risk price, whichever is more. When the price cannot be read, their part
   of the whole remaining budget is held.
3. **Paid in kind.** Backing in USDT or SOL is held as posted and paid back
   in the pot's mix. SOL counts at 80% toward the budget and falls with the
   SOL price.

See [How to underwrite a market](how-to-underwrite-a-market.md).

## The pool

1. **Every market at once.** Pool liquidity takes the losses backers do not,
   up to each market's budget, across all markets together.
2. **Withdrawals wait 150 slots,** about a minute. Shares sit in escrow,
   still exposed, and are paid at what the pool is worth when claimed, not
   when requested.
3. **Paid in kind.** A claim pays USDC plus the same share of any tokens
   the LPs hold from backing they covered.
4. **Priced from a checkpoint.** Deposits and withdrawals price shares from
   a pass over every market at most 60 seconds old. While a market's price
   is unreadable, a deposit counts it at the least it could cost the LPs and
   a withdrawal at the most, so neither can profit from the stale price.

See [The pool](pool.md).

## Liquidity

A batch fills only what crosses. A thin market can leave an order unfilled,
or fill it far from the reference price inside the band. The pool fills only
what makers leave, and only within the market's budget. See
[The auction](auction.md).

## Points

1. **Points are not a token** and not a promise of one.
2. **They can be farmed with many wallets.** The program caps trading points
   at 250,000 per wallet per UTC day and pays nothing on a close held under
   10 minutes. It cannot tell one person's wallets apart. Each extra wallet
   gets its own cap.
3. **Seasons and creator scores are kept by the server,** not the program.
   The on-chain total per wallet is all-time.

See [Referrals and points](rewards.md).

## Listing

Anyone can open a market. A market on unwind is not an endorsement of the
asset, its issuer or the account that opened it.

## Devnet

Today unwind runs on devnet only. It settles in test USDC against devnet
copies of tokens marked at their mainnet prices. Balances carry no value, and
parameters, pools and markets can change or be reset. See [Devnet](devnet.md).

## Assets and jurisdictions

Tokenized stocks (xStocks) are not available to US persons. unwind is not
affiliated with Backed, Jupiter, Pyth, Raydium, Meteora or the issuers of the
assets its markets track. You are responsible for the rules where you live.
