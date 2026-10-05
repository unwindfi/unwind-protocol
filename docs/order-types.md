# Order types

## Overview

unwind has one order object, which is a price trigger. It carries a price, a
direction from which that price must be crossed, and an instruction for what
to do once it is. Limit orders, take profit orders and stop loss orders are
the same structure with different fields set, rather than separate mechanisms.

Representing them as one object rather than three keeps the surface a
liquidation or a settlement has to reason about to a single shape.

## The two kinds

An order is either an open or a close.

An **open** order creates a position when its trigger is crossed. It escrows
its collateral at submission rather than at execution, because an order
resting against a batch is a commitment to trade at that batch's clearing
price. Collateral belonging to a portion that does not fill is returned at
settlement.

A **close** order reduces or closes an existing position. It escrows no
collateral, since the position it acts on has already posted its own. A close
order whose size is left at zero closes the entire position, which is what a
stop loss almost always intends.

## Makers and takers

Every order that reaches a batch is a maker or a taker, and that decides which
of the batch's two auctions it clears in. See [Clearing](auction.md).

A **taker** wants a fill in the next batch. Market orders, closes and every
order a trigger fires are takers. A taker only trades with makers, or with the
[pool](pool.md) when no maker is there. A taker that nothing fills lapses
with its batch and its collateral comes back at settlement; a fired trigger
is spent either way.

A **maker** rests as liquidity at a price it names. It only trades with
takers, never with the pool and never with another maker. A maker order lasts
one batch: if nobody takes it, its collateral comes back when the batch seals
and it quotes again into the next one. Anyone can submit a maker order, by
setting `is_maker` on `submit_order` or `maker: true` on the devnet API's
order endpoint, and a maker order must carry its own price.

## Post only

The trade screen's limit tab has a **Post only** box. With it ticked, the
order is sent as a maker at the limit price, rather than as a limit trigger.

A post only order never trades with the pool and never takes. It fills only
when a taker in the same batch crosses its price, and it fills at that flow's
clearing price, which is never worse than the limit. It rests for one batch.
If no taker crosses it by the time the batch seals, the order lapses and its
collateral comes back at settlement. To quote again, place it again.

A post only order posts the same margin and pays the same fees as any other
open. It cannot be reduce only, and it has no time in force, since it lasts
one batch either way.

## Positions do not flip

A position is long or short, and an open order must be on the side the
position already holds. An open against the other side is refused when it is
submitted, and so is an open against the other side of an open the same
account already has resting in the batch. One account cannot be on both
sides of a batch's opens, so it cannot cross itself.
To change sides, close the position first.

## Execution

Orders are executed by whoever is watching. There is no designated keeper and
no privileged execution path, which is consistent with clearing, settlement
and liquidation being permissionless for the same reason: none of these
operations accepts a price or a discretionary input from its caller.

On devnet the venue's own server watches every order and checks each trigger
against the mark every three seconds, so a take profit or stop fires within a
few seconds of its price being reached.

A trader may hold several orders against a single market simultaneously. A
take profit and a stop loss on the same position is the ordinary case. There
is one of each per market: setting a take profit, stop or limit where one
already stands replaces it, cancelling the old one and placing the new one in
the same transaction.

Closing a whole position from the site cancels its take profit and stop loss
in the same transaction. A trigger order whose position is already gone, for
example after a liquidation, is marked "No position" under Open Orders and
should be cancelled: left standing, it would act on the next position opened
on that market.

## Limits

A batch holds 64 orders for everyone, so it carries two limits that keep one
trader from filling it:

* A wallet may have at most four resting orders in a market's batch at once.
* A reduce-only order must be at least the market's minimum position size,
  unless it closes everything left in the position. Reduce-only orders post
  no collateral, so without a floor they would cost nothing to place, and
  enough of them priced never to cross could block every exit behind them.

Both apply to an order a trigger fires as well as to one submitted by hand.

## Checks on a trigger

A trigger order is checked twice. When it is placed, an open must fit the
same caps as an open submitted by hand: the side the position holds, the
market's maximum leverage and its open interest cap, all as they stand then.
Nothing can be placed on a paused pool, and only close orders on a paused
market. When it fires, an open is checked again against the position, the
market and the opens already resting in the batch, because any of them may
have changed since. A trigger that fails either check never reaches the
batch, so it never moves a clearing price. One that fails when it fires
stays in place until it fires, expires or is cancelled.

A cancelled order's escrow is paid back from the vault of the pool its
market belongs to, and from no other.
