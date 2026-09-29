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
from the underlying pool. The budget also falls on its own when backing is
withdrawn, or when the price of a token the backing is held in falls.

A budget rises only when somebody posts backing. No account can raise it any
other way, the protocol authority included. The authority can lower a budget
with `set_market_budget`, as a brake on a market it no longer trusts.

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

The pool's participation is also capped by what is left to reserve. Every open
position reserves part of the budget against the profit it might make, and the
pool takes no more in a batch than the reserve behind it would fit under that
cap. The budget is enforced at this point, when the batch clears, and not when
its orders settle:

* Traders who cross each other still trade when the budget is spent, because
  that fill adds no net exposure for the pool.
* An open that no longer fits a limit at settlement (leverage, open interest,
  pool utilization) goes back to its owner unfilled, with its collateral.
* A reduce-only order fills as far as the remaining budget, and the money
  behind it, can pay. Any part it cannot pay stays open, and a winning
  position the budget cannot pay becomes eligible for deleveraging at the
  oracle mark, where it is paid its collateral and whatever profit the budget
  still covers, and no more.

So every batch settles, and a market with no budget left stays open for exits.

## Numerical example

Suppose the observation determines that moving a tracked asset's spot pool by
one percent costs 40,000 USDC.

1. Backers post 50,000 USDC. Anyone may cut the market's loss budget to
   40,000 USDC.
2. The pool's participation in a single one second window is capped at 2,000
   USDC, being five percent of the remaining budget.
3. After losses consume 30,000 USDC, the remaining budget is 10,000 USDC and
   the per window cap falls to 500 USDC.
