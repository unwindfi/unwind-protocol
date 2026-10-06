# Portfolio

## Overview

The portfolio page, at `/portfolio`, shows everything one wallet holds on
unwind in one place: open positions, standing orders, xLP in the pool,
backing behind markets, and recent fills. Add `?wallet=<address>` to view any
wallet read only; every figure on it is public on chain.

## What it shows

**Account value** is the wallet's USDC, the margin in its positions, their
unrealized PnL, the value of its xLP and the value of its backing, added
together. It is what the wallet would hold if it closed every position and
withdrew everything at current prices, before fees.

**Positions** lists each open position with its size, entry, mark, PnL,
liquidation price and margin. PnL is taken at the price a close would fill
at, which is half the spread from the mark; hover the mark to see it. A row opens that market on the trade screen.

**Orders** lists take profits, stops and limit orders still waiting to fire.
The owner can cancel any of them from the page. A limit order's escrowed
collateral is returned when it is cancelled. Orders resting in a collecting
batch are not listed; they clear within the batch window.

**Backing** lists each market the wallet backs, and **Pool deposits** its
xLP, each with what it is worth now, what was deposited and the difference.
Neither is a trading position: a market the wallet listed shows up here as
backing, and a trade in the same market stays under Positions. For xLP the
deposit is the cost the program recorded for tokens this wallet minted; xLP
received any other way has no recorded cost and shows none.

## History

The program keeps positions, not a log of fills. The history on this page is
what the server has settled for the wallet since it last started: fills,
liquidations and triggers that fired, up to the latest 50. A restart clears
it. Every fill is still a transaction on chain and can be found from the
wallet's address on an explorer.
