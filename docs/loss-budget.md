# Loss budget

Every market has a loss budget: the most it may cost the LPs over its life. A
market tracking a thin asset can be moved cheaply. Without a budget, moving a
spot price would buy access to the whole pool.

## Key figures

| | |
| --- | --- |
| Raised by | backing posted behind the market, and nothing else |
| USDC, USDT backing | counts 100% |
| SOL backing | counts 80% of its value |
| Cut to depth by | anyone, on an observed market with a seasoned mark |
| Depth a cut uses | moves 10% of the gap per 20 seconds at most; up by no more than 10% of itself |
| Lowered by the authority | `set_market_budget`, down only |
| Pool size per batch | 5% of the remaining budget |
| Reserved per open position | nothing |

## The remaining budget

```
remaining = loss_budget - net_loss       when net_loss > 0
remaining = loss_budget                  otherwise
```

`net_loss` is what the market has cost the LPs so far, realised. A gain
unwinds earlier losses first. It never grows the budget past what was
underwritten: a market cannot bank profit into a larger allowance.

## How the budget moves

**Up.** Only when someone posts backing, and only by what that deposit counts
for, up to what stands behind the market:

```
cap    = backing behind the market + net_loss
budget = max(budget, min(budget + counted, cap))
```

Fee income credited to backers raises nothing. No key can raise a budget any
other way, the authority included.

**Down, by itself.** The budget follows the backing down. When backing is
withdrawn, or a token it is held in falls in price, the budget is held to
`cap`. Adding back `net_loss` stops losses from counting twice: the budget is
a lifetime figure and the backing is what is left after losses drew on it.

**Down, by depth.** `derive_market_budget` is permissionless and only cuts. It
sets an observed market's budget to its budget depth, the cost of moving the
pool 1%, when that is below the budget and the mark is seasoned. Budget depth
is depth that has held:

1. The first reading sets it.
2. After that it moves toward each reading by 10% of the gap, at most once
   every 20 seconds.
3. A rise is also capped at 10% of where it stands.

One thin reading cuts nothing. One deep reading undoes nothing. If a pool
drains to a tenth of its depth and stays there, budget depth falls halfway in
about 3 minutes and to twice the new depth in about 7. The
venue's keeper sends the cut whenever budget depth is below the budget.

**Down, by the authority.** `set_market_budget` lowers a budget, never raises
it. It is a brake on a market the authority no longer trusts.

{% hint style="info" %}
Depth can be rented for a slot. An account that could raise a budget by
parking liquidity in the spot pool would be writing its own allowance. That is
why the operation does not exist, rather than being restricted to a privileged
caller.
{% endhint %}

## What the budget limits

The budget is enforced on what the pool takes on and what winners are paid,
not on what traders open.

1. **The pool's size.** The pool fills at most 5% of the remaining budget per
   flow per batch. A spent budget means the pool stops quoting. Trades that
   bring the pool back toward flat are also taken, up to the long/short
   imbalance, so exits are not throttled.
2. **Crossed trades.** Traders who cross each other still trade when the
   budget is spent. That fill adds no net exposure for the pool.
3. **Profit paid.** A winning close is paid its collateral and its profit.
   When the market cannot cover every winner, profit is cut to a fair share.
   See [Profit haircuts](auto-deleveraging.md).
4. **Liquidations.** A liquidated position is paid at most its collateral
   plus the remaining budget.

Leverage and open interest are checked when an order enters the batch, not
against the budget. A close is never shrunk by the budget: it fills what the
auction gives it, and only the profit it is paid can be cut.

So every batch settles, a market with no budget left stays open for exits,
and no market pays out more than it was underwritten for.

## Who pays a loss

A loss the market takes is paid in this order:

1. **Backing**, posted by the market's underwriters.
2. **LP liquidity.**
3. **Insurance fund**, only for what liquidity cannot cover.

All three only up to the remaining budget. A later gain repays backing first,
up to what losses drew from it, then goes to the LPs.

## Numerical example

An observed market whose pool costs $40,000 to move 1%.

1. Backers post $50,000 USDC. The budget is $50,000.
2. Once budget depth has held at $40,000, anyone cuts the budget to $40,000.
   Posting $1 more raises it to $40,001, not back to $50,000.
3. The pool's size per batch is 5% of $40,000: $2,000.
4. Losses consume $30,000. Remaining budget: $10,000. Pool size: $500.
   Backing left: $20,000.
5. A backer withdraws $15,000, leaving $5,000. Cap: $5,000 + $30,000 =
   $35,000. Budget: $35,000. Remaining: $5,000.
6. Had they posted $10,000 instead: cap $60,000, budget $50,000, remaining
   $20,000.
