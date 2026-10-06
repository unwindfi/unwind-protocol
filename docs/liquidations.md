# Liquidations

A position whose equity at the risk price falls below its maintenance margin
can be closed by any account. The account that does it is paid out of the
liquidation fee.

## Key figures

| | |
| --- | --- |
| Trigger | equity at the risk price < maintenance margin |
| Close price | worse of the risk price and the oracle, for the position, less the spread |
| Liquidation fee, site listing | 100 bps of size |
| Liquidator's share of the fee | 60% |
| Protocol, insurance, chain cuts | 20%, 10%, 10%, kept in the pool |
| Most a liquidated position is paid | its collateral plus the market's remaining budget |
| Devnet keeper check | every 3 seconds |
| Risk price step | at most 1.2% per step |

## How it works

`liquidate` takes no price and no choice from the caller:

1. Accrue funding to now.
2. Read the market's price and step its risk price toward it.
3. Value the whole position at the risk price, on the closing side of the
   spread. If equity is not below maintenance, refuse.
4. Close the whole position at the worse of the risk price and the oracle
   for it: the lower for a long, the higher for a short.
5. Pay out what is left.

```
equity  = min(equity at close price, collateral + remaining budget)
fee     = min(size × liquidation_fee_bps, equity)
to owner      = equity - fee
to liquidator = fee - (20% + 10% + 10% of fee)
```

The trigger reads the risk price, so a reading the risk price has not had
time to follow liquidates nobody. The close reads the worse of the two, so
what the owner gets back is never priced off a risk price still catching up
with a fall. See [Price sources](price-sources.md#the-risk-price).

The fee comes out of the position's equity and never out of pool capital. A
position already through zero pays no fee. On a backed market the liquidator
still takes the whole 60%; backers get no part of a liquidation fee.

`liquidate` also works on a paused market. A pause stops new risk; it does not
trap a position already through its margin.

## Worked example

A $5,000 long from $100 at 5x: $1,000 of collateral after the open fee, on a
site listing (10% maintenance, so $500; 100 bps fee, so $50; 20 bps spread).
Funding is left out, and the risk price has caught up with the oracle.

1. Risk price $90.30. Exit at the bid: about $90.12. PnL: $5,000 × (90.12 /
   100 - 1) = -$494. Equity: $506. Not below $500. Healthy.
2. Risk price $89.90. Exit about $89.72. PnL -$514. Equity $486. Below $500.
   Liquidatable.
3. Fee: $50. Liquidator: $30. Pool keeps $20 (protocol $10, insurance $5,
   chain $5). Owner gets $436.

## When the collateral is not enough

A liquidation can complete past zero equity. Equity is floored at zero: the
position loses its collateral, pays no fee, and the pool books a smaller gain
than the mark implied. Nothing is owed after that.

A liquidated position in profit is never paid past its collateral plus its
market's remaining budget. See [Profit haircuts](auto-deleveraging.md).

## Why anyone can liquidate

A keeper cannot produce a better outcome than an arbitrary caller, since the
instruction takes no input. A keeper that stops would prevent the outcome
entirely. So liquidation, clearing and settlement are all permissionless. The
worst a stalled crank can do is leave orders resting where their owners put
them.

## The venue's keeper

Anyone may liquidate, but the venue runs a keeper so nobody has to.

1. It holds every open position in memory and checks each against the live
   price every 3 seconds.
2. It reads the full list from the chain every minute, and re-reads a wallet
   after any fill it settles or transaction it relays for it.
3. For every market with a position past its margin, it first sends
   `step_risk_price`, then tries the liquidation.
4. A position the program still finds healthy at the risk price is tried
   again on the next check. At 1.2% per step, a 6% move takes about five
   steps to reach.
5. A liquidation that fails for any other reason waits 30 seconds.

The mark keeper moves an observed mark at most 10% a push after holding a
larger move for one pass, so a crash crosses each liquidation price on the
way down instead of jumping past it.
