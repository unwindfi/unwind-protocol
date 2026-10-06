# Corporate actions

A 4-for-1 split moves a stock's price to a quarter in one tick. Applied to open
positions as is, every short would read 300% down and every position would
liquidate for an arithmetic reason, with nobody having lost anything.

## How an action is applied

`apply_corporate_action` takes the factor the price is multiplied by. A
4-for-1 split passes 1/4.

Preconditions:

1. Only the pool authority can send it.
2. The market must be paused first. An action applied while fills land would
   mark some positions before the split and some after, against one index.
3. A batch that has cleared but not fully settled is refused. Its fills were
   priced in the old terms. Settle it first (anyone can), then apply.
4. On an observed market, the observation account must be passed.

Liquidation keeps working while the market is paused.

## What moves, in the same instruction

| Price | What happens | 4-for-1 example |
| --- | --- | --- |
| Market price factor | multiplied by the ratio | 1 → 0.25 |
| Side average entries | multiplied by the ratio | $200 → $50 |
| Risk price | multiplied by the ratio, at once | $200 → $50 |
| Last accepted price | multiplied by the ratio | $200 → $50 |
| Resting limits in the open batch | multiplied; buys round down, sells round up | a $201 buy → $50.25 |
| Observed mark and last pool reading | multiplied by the ratio | $200 → $50 |
| Position entries | rebase lazily through the factor on next touch | $180 → $45 |
| Trigger prices | rebase lazily when they fire | a $180 stop fires at $45 |

Left behind, the risk price would walk down at 1.2% a step, and every short
would read 300% down for over a hundred steps.

Rounding never loosens a limit: a buy's ceiling rounds down and a sell's floor
rounds up. Positions rebase through the factor rather than being rewritten,
so the action costs the same however many positions the market holds.
Triggers placed before the factor was recorded read as placed at the original
factor.

## What resets

The market's tracking sums for its positions (the moment sums behind the
profit haircut, and the funding sums behind the pool's valuation) are emptied.
Every open position stops being tracked. Until those positions close or are
added to:

* the [profit haircut](auto-deleveraging.md) counts each side's winners at its
  net profit, the rule before the bound existed;
* the [pool's value](pool.md) counts price PnL without the funding positions
  owe, and adds no bad-debt bound on the claim side.

## When to apply

Apply the action once the price source itself has moved to the new terms. A
reading still in the old terms after the action is a 4x move to the market.

A trader's economic exposure is the same before and after.
