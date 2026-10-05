# Loss budget

## Overview

Every market carries a budget describing the maximum it is permitted to lose
before it stops quoting. The budget exists because a market tracking a thinly
traded asset can be moved cheaply, and a venue that allowed such a market
unlimited access to the liquidity pool would be offering an attacker the pool
in exchange for the cost of moving a spot price.

## How the budget is set

The budget is raised by backing: collateral somebody posts behind the market,
which is the first thing the market's losses consume. USDC and USDT count in
full and SOL at 80 percent of its value. See
[How to underwrite a market](how-to-underwrite-a-market.md).

It is capped by the tracked asset rather than by an administrator. The
observation measures the cost of moving the asset's spot pool by one percent,
and any account may cut a market's budget to that figure as liquidity drains
from the underlying pool. The figure a cut uses is depth that has held: it
rises to a deeper reading at once and falls toward a thinner one by a tenth of
the gap at most once every 20 seconds. One thin reading cuts nothing, and a
pool that has really drained takes about seven minutes to cut a budget to a
tenth. The budget also falls on its own when backing is withdrawn, or when the
price of a token the backing is held in falls.

A budget rises only when somebody posts backing, and only by what that
deposit counts for, up to the backing behind the market. Fee income credited
to the backing raises nothing. No account can raise a budget any other way,
the protocol authority included. The authority can lower a budget with
`set_market_budget`, as a brake on a market it no longer trusts.

{% hint style="info" %}
Depth is temporarily purchasable. An account able to raise a budget by
parking liquidity in the spot pool for a single slot would be authorising its
own allowance, which is why the operation does not exist rather than being
restricted to a privileged caller.
{% endhint %}

## Relationship to the pool

The pool's participation in any single auction is capped at five percent of
the market's remaining budget. As the budget is consumed by losses, that per
window cap falls with it, and a market whose budget is exhausted stops
quoting rather than quoting into exposure it cannot fund.

Nothing is reserved against an open position. The budget is enforced on what
winners are paid instead:

* Traders who cross each other still trade when the budget is spent, because
  that fill adds no net exposure for the pool.
* Leverage and open interest are checked when an order enters the batch.
  Open interest there counts every open already resting on the same side,
  so a side ends a batch at its cap at most. An open the batch filled is
  then booked at settlement without checking again: a refusal there would
  depend on which order was settled first, and would leave the order it
  crossed booked against the pool alone.
* A reduce-only order always fills in full. A winning close is paid its
  collateral and its profit, cut to a fair share when the market cannot cover
  every winner: each is paid `available / winners` of what it is owed, where
  `available` is the remaining budget (or the money behind it, if less). See
  [Profit haircuts](auto-deleveraging.md).

So every batch settles, a market with no budget left stays open for exits,
and no market pays out more than it was underwritten for.

## Numerical example

Suppose the observation determines that moving a tracked asset's spot pool by
one percent costs 40,000 USDC.

1. Backers post 50,000 USDC. Once the depth has held at 40,000 USDC, anyone
   may cut the market's loss budget to 40,000 USDC. Posting 1 USDC more
   raises it to 40,001 USDC, not back to 50,000.
2. The pool's participation in a single one second window is capped at 2,000
   USDC, being five percent of the remaining budget.
3. After losses consume 30,000 USDC, the remaining budget is 10,000 USDC and
   the per window cap falls to 500 USDC.
