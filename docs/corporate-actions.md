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

A trader's economic exposure is unchanged across the corporate action.
