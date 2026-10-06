# Portfolio

## Overview

`/portfolio` shows everything one wallet holds on unwind: positions, standing
orders, backing, pool deposits and recent fills. Add
`?wallet=<address>` to view any wallet read only. Every figure on it is
public on chain. Only the owner can cancel.

## Account value

What the wallet would hold if it closed every position and withdrew
everything at current prices, before fees:

| Line | What it is |
| --- | --- |
| Available USDC | USDC in the wallet |
| Margin | Collateral in open positions |
| Unrealized PnL | What the positions are up or down |
| Position equity | Margin plus unrealized PnL |
| Pool (xLP) | xLP in the wallet at the pool's price |
| Backing | What the wallet's backing shares are worth now |

Account value is available USDC, position equity, xLP (including xLP waiting
in a withdrawal request) and backing, added together. Two more lines sit
beside it and are not added in: **USDC to claim** (referral and listing
rewards, claimed on Rewards) and **Volume**.

## Cards

**Positions.** Each open position: market, side, size, entry, mark, PnL,
liquidation price and margin. PnL is taken at the price a close would fill
at, half the spread from the mark; hover the mark to see it. A row opens the
market on the trade screen.

**Orders.** Take profits, stops and limit orders still waiting to fire. The
owner can cancel any of them from here. A canceled limit order's escrowed
collateral comes back. Orders resting in a collecting batch are not listed;
they clear within the 1 second window.

**Backing.** Each market the wallet backs: value now, what was deposited,
the change, and the market's status (Live, Opening, or Waiting for a
budget). A row opens that market's vault page.

**Pool deposits.** The wallet's xLP: value now, what it cost, and the
change. The cost is what the program recorded for tokens this wallet minted.
xLP received any other way has no recorded cost and shows none.

Backing and pool deposits are not trading positions. A market the wallet
listed shows up under Backing; a trade in the same market stays under
Positions. Both are changed on [Earn](https://unwindfi.xyz/earn).

## History

The program keeps positions, not a log of fills. History is what the server
has settled for the wallet since it last started: fills, liquidations and
triggers that fired, the latest 50. A restart clears it. Every fill is still
a transaction on chain, findable from the wallet's address on an explorer.
