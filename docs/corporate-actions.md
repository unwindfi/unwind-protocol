# Corporate actions

## Overview

A stock split re-prices the underlying asset by a fixed ratio in a single
tick. Applied to open positions without adjustment, that discontinuity
liquidates every position in the market for an arithmetic reason rather than
an economic one, despite no participant having sustained an economic loss.

## Technical details

Splits are applied through a market wide price factor rather than to
positions directly. Individual positions rebase through that factor lazily,
on the next interaction with the position, which keeps the operation constant
in cost regardless of how many positions the market holds.

Every other price the market holds moves in the same instruction:

1. The risk price, which liquidation reads, and the last accepted price are
   multiplied by the same ratio. A 4-for-1 split takes a $200 risk price to
   $50 at once. Left behind, it would walk down at 1.2% a reading and every
   short would read 300% down for over a hundred readings.
2. Limit prices resting in the market's open batch are rescaled. A buy's
   ceiling rounds down and a sell's floor rounds up, so no limit gets looser.
3. A batch that has cleared but not fully settled is refused. Its fills were
   priced before the split. Settle it first (anyone can), then apply the action.
4. On an observed market the mark and the last pool reading are rescaled, and
   the observation account must be passed.
5. Stop-loss, take-profit and limit triggers keep the price factor they were
   placed under and rebase when they fire. A long's stop at $180 placed before
   a 4-for-1 split fires at $45. Triggers placed before this was recorded read
   as placed at the original factor.

Apply the action once the price feed itself has moved to the new terms. A
reading still in the old terms after the action is a 4x move to the market.

A trader's economic exposure is unchanged across the corporate action.
