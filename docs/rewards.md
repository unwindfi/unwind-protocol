# Referrals and points

## Overview

Two kinds of reward, both counted by the program on chain.

| Reward | What it is | Paid from |
| --- | --- | --- |
| Points | A record of use. Not a token, not a promise of one. | Nothing: they are a tally |
| USDC | Paid to referrers and to whoever opened a market | The protocol's share of each trading fee, and nothing else |

Every wallet has a `Trader` account that holds both. It is made the first
time the wallet places an order, backs a market, adds liquidity or takes a
referral code. Anyone can read any wallet's tally there. USDC is claimable at
any time from [Rewards](https://unwindfi.xyz/rewards).

No multipliers. No off-chain ledger for the totals.

## Earning points

| Activity | Points |
| --- | --- |
| Opening a position | 0 |
| Closing a position held 10 minutes or more | 2 per $1 closed |
| Closing sooner | 0 |
| Liquidation or deleveraging | 0 |
| Referring | 10% of a referee's trading points, once the referee has $1,000 of held volume |
| Opening a market | 10% of the trading points its traders are credited, never on your own trades |
| Backing a market | 2 per $1 of backing per day |
| Providing liquidity | 1 per $1 deposited in the pool per day |

A referee keeps all of their own points. The referrer's and deployer's
shares are extra, not taken from the trader.

## Trading points

1. **An open earns nothing.** Points are paid on the close, for both legs:
   $1,000 closed earns 2,000 points.
2. **10 minutes.** The size closed must have been open at least 600 seconds.
   A sooner close earns 0, and so did its open.
3. **Adding moves the clock.** Held time is size-weighted. Adding $1,000 to
   $1,000 held 10 minutes puts the whole at 5 minutes held. A partial close
   leaves the clock alone. A position emptied and opened again starts from
   zero.
4. **250,000 points per wallet per UTC day,** which is $125,000 closed. What
   a close would earn past that is not credited and not carried over. The
   count restarts at 00:00 UTC.

Volume still counts every fill, opens and closes, for the wallet and the
market. Only points follow the rules above. The program keeps each wallet's
`trading_points`, `points_today` and `held_volume_usd` (the round trip
notional of closes held 10 minutes or more) on its `Trader`.

## Backing and pool points

**Backing** earns twice the pool's rate because it takes first loss (see
[How to underwrite a market](how-to-underwrite-a-market.md)).

1. Counted on what was posted, in dollars at the time.
2. Cut in proportion to shares withdrawn.
3. Never more than the stake is still worth. When the market's losses draw
   on the backing, the stake is cut to its share of what is left at the next
   deposit, withdrawal or `mark_backing`, which anyone may send.

**Pool** points are counted on the xLP a wallet minted and still holds.

1. xLP can move between wallets without the program seeing it. Tokens sent
   away stop earning at the next update and do not start again if they come
   back. Tokens received from someone else earn nothing.
2. xLP in a pending withdrawal earns nothing. A cancelled withdrawal earns
   again from the cancel.

## Referrals

A wallet takes a referral code once: 3 to 16 characters of `a` to `z`, `0`
to `9`, `_` and `-`. First come, permanent. Its link is
`unwindfi.xyz/r/<code>`; `unwindfi.xyz/?ref=<code>` works too.

A wallet that arrives on a link names that code's holder as its referrer
with its first order, or from the Rewards page before trading. The referrer
can be set once, only before the wallet's first fill, and never to itself.

Once referred, a wallet:

1. pays **10% less** on every open and close fee;
2. owes its referrer **10% of every fee it pays**, in USDC, from the first
   fill;
3. owes its referrer **10% of its trading points** once it has **$1,000 of
   held volume** (a $500 position held 10 minutes and closed is $1,000).
   Points earned before that owe the referrer nothing, then or later.

Liquidation fees are not discounted and carry no referral share.

## Opening a market

Whoever opens a market (its `deployer`, see
[How to open a market](how-to-open-a-market.md)) is owed:

1. **10% of every fee** paid on that market, in USDC;
2. **10% of the trading points** its traders are credited.

Neither is paid on the deployer's own trades. The deployer earns trading
points on those like anyone else, and nothing as the deployer.

They trade their own market at **half the fee**. Only that market: a
discount on every market would make opening a throwaway market the cheapest
way to trade everything else. The deployer discount and the referral
discount do not stack; the larger applies.

## Where the USDC comes from

Out of our cut. Referral and listing rewards come from the protocol's share
of each fee and nothing else.

On the default split (see [Fees](fees.md)) the protocol gets 20% of every
fee. On a fee paid by a referred trader on a market somebody else opened,
10% goes to the referrer, 10% to the deployer, and the protocol keeps
nothing. The pool, backers, insurance fund and chain are paid exactly what
they would be with no referral.

When the protocol's share is smaller than the rewards on a fee, the referrer
is paid first and the deployer's share is cut to fit. The USDC sits in the
pool's vault on its own line, `rewards_usd`, until claimed, so it never
counts as LP capital.

## Syncing

Settlement never needs a referrer's or deployer's account, which keeps as
many orders as possible in one settlement transaction. What a trade earns
them is left on the referee's `Trader` and on the market. Two
permissionless instructions move it:

1. `sync_referral` moves a referee's owed points and USDC to their referrer.
2. `sync_deployer` moves a market's owed USDC and points
   (`deployer_points_owed`) to its deployer.

Neither can pay anyone but the account the program says is owed. The devnet
server runs both every minute, and claiming on the Rewards page syncs the
wallet's own markets first. Backing and pool points are brought up to date
whenever the stake changes, or by the wallet calling `accrue_points`. A
wallet with pool tokens it minted must show its pool token account when it
does, since the stake is cut to what that account holds.

## One pool per wallet

USDC rewards sit in one pool's vault, so each wallet's rewards are tied to
one pool: the first one that credits it USDC.

1. `claim_rewards` pays only from that pool.
2. `sync_deployer` moves a market's USDC only to a deployer tied to the
   market's pool, and `sync_referral` only to a referrer tied to the
   referee's pool. Anything else stays owed where it is.
3. A referred wallet is tied to the first pool it trades in. A fill in any
   other pool keeps its discount but carves nothing for its referrer.
4. The tie moves once nothing is left in the old pool's books: no USDC
   waiting to be claimed and no referrer's cut waiting to be synced. Claim
   what the first pool holds, then sync, and the wallet is tied to the pool
   that pays it.

## Pools that earn no points

A pool earns points only if the program's upgrade authority created it or
switched its points on.

1. On a devnet build anyone may create a pool, in a token of their own, so a
   deposit, backing or fill there costs nothing real. Such a pool is created
   with `Pool::no_points` set.
2. In it: no trading points, no volume, no referrer's cut, no deployer
   points, no backing or pool points. `accrue_points` refuses its pool token
   account. A deployer's USDC share is still carved from the fee.
3. The upgrade authority switches a pool's points on or off with
   `set_pool_points`. Nobody else can, and nobody can once the program is
   immutable.

The devnet pool was created from a fresh key and then switched on with the
deployer key, so it earns points.

## Seasons

The on-chain total is all-time. A season is a view over it, kept by the
server: when it starts on a new pool it stores every wallet's totals, and
the Rewards page, leaderboard, weekly view and creator ranking show what was
earned since. Season 2 started 6 October 2026 on devnet's new pool (see
[Devnet](devnet.md)).

## Numerical example

A referred trader opens $10,000 on a market with a 10 bps open fee, which
somebody else opened.

1. The full fee would be $10. With the referral discount it is $9.
2. The open earns 0 points.
3. The protocol's 20% of $9 is $1.80. Of it, $0.90 goes to the referrer and
   $0.90 to the deployer.
4. The chain ($0.90), insurance fund ($0.90) and pool ($5.40, half of it to
   backers if the market has any) are paid as usual.
5. 20 minutes later the trader closes all $10,000. The close earns 20,000
   points. The trader already has $1,000 of held volume, so the referrer is
   owed 2,000 and the deployer 2,000.
6. Closed after 5 minutes instead, it earns 0, and so do they.

## Leaderboard

The Rewards page ranks every wallet with points this season, and for the
current week (from Monday 00:00 UTC), and pins the viewer's own row. It also
publishes the share of points the top 20 wallets hold. Wallets the venue
runs (the pool authority, devnet's market maker, the demo trader, the price
relay) earn points like anyone else and are left off the ranking.

Below it, devnet creators are ranked by distinct traders (see
[Devnet](devnet.md)).

## Rules changelog

Rules change only going forward. Points already earned are never recounted.

| Version | From | Change |
| --- | --- | --- |
| v1 | Season 1 | 1 point per $1 filled, opens and closes; 10% to referrers and deployers. |
| v2 | 2026-10-06 | Points on closes only, 2 per $1 closed after 10 minutes held. 250,000 trading points per wallet per UTC day. Referrers earn points only once a referee has $1,000 of held volume. Deployers earn 10% of trading points credited, nothing on their own trades. Season 2 starts on devnet's new pool, counted from zero. |
