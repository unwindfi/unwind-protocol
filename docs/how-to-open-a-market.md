# How to open a market

## Overview

Opening a market is one signed transaction. No approval, no relationship
with the protocol. The account that sends it gets no rights over the market
afterwards.

A market trades once it has a price and a loss budget. From the site, both
arrive with the listing: the backing is in the listing transaction, and the
mark keeper prices the market on its next pass.

## Steps

1. **Find the token.** Search by ticker, name or mint. The site reads every
   USDC or USDT pool the token has on Raydium CLMM and Meteora DLMM and picks
   the most liquid. An asset with a Pyth feed can use the feed instead. The
   market takes its ticker and name from the token's own metadata. A token
   with none is listed under the first characters of its mint as "Unnamed
   token" (on devnet, a token with no name and no logo is then hidden; see
   [Devnet](devnet.md)).
2. **Review the limits.** Open interest per side defaults to what the pool's
   depth supports, at most $50,000 and at least $1,000. Leverage starts at
   2x and rises with sustained depth up to 5x (see
   [Margining](margining.md)). Both can be lowered under Advanced. The
   leverage set there is a ceiling depth cannot lift.
3. **Post the backing.** At least $100, in USDC, USDT or SOL, in the same
   transaction. The program will list an unbacked market; the site will not.
4. **Tick the box** confirming the backing takes the market's losses first,
   up to what it holds. The site will not sign until it is ticked.
5. **Sign,** and pay the rent of the accounts the listing creates.

## What the site lists with

| Parameter | Value | Program bound for a non-authority listing |
| --- | --- | --- |
| Max leverage | Your choice, at most 5x; depth sets what applies | at most 5x |
| Open interest per side | $1,000 to $50,000 | $1,000 to $50,000 |
| Open fee | 10 bps | 10 to 100 bps |
| Close fee | 10 bps | 10 to 100 bps |
| Liquidation fee | 100 bps | at most the margin it is taken from |
| Maintenance margin | 1,000 bps | at least 500 bps |
| Base spread | 20 bps | at least 10 bps |
| Least position | $10 | at least $10 |
| Max price age | 120 seconds | at most 120 seconds |
| Max funding rate | 100 bps an hour | at most 200 bps an hour |
| Borrow rate | 1 bp an hour | |
| PnL reserve | 10,000 bps | at least 10,000 bps |

The program enforces the bounds, so a transaction built by hand gets nothing
the site would not give it.

## Listing a token again

A token can be listed more than once. Each listing of the same pool or feed
is a new generation of its market, at an address of its own.

1. The first listing is generation 1, the next generation 2. The number only
   goes up, and no address is ever reused.
2. The program counts them in a `MarketGenerations` account per pool and
   feed. A listing names the generation after the newest; two listings racing
   for the same number, the second fails.
3. Anyone can list the next generation. A market listed with a bad price
   source or settings nobody wants holds its own address and nothing else.
4. Only a market's lister can create its price observation, so nobody can
   choose its observation settings between the listing and the lister's next
   transaction.
5. Markets listed before generations existed are generation 0 at their old
   address. They keep trading.

The site shows, per token, the newest generation that has backing, or the
newest if none does. An unbacked relisting does not replace a backed market
until someone backs it. The site refuses to list over a market it shows as
live (backed, not paused, and observing the pool with the site's own
settings) and lists the next generation otherwise.

## When trading opens

At once. The mark keeper reads every market every 25 seconds, and its first
push makes a new market tradeable. No warm-up. See
[Price sources](price-sources.md).

## Units

A token worth less than a cent is quoted per thousand, per million or per
billion, the smallest unit worth a cent again. BONK at $0.0000038 trades as
$3.81 per 1M. A token worth a cent or more trades one token at a time.

## What opening a market earns

Nothing until it is traded. Then, as the market's `deployer`:

| Reward | Amount |
| --- | --- |
| USDC | 10% of every trading fee paid on the market, out of the protocol's 20% |
| Points | 10% of the trading points the market's traders are credited |
| Discount | Half the fee when you trade your own market |

None of it is paid on your own trades on the market. Liquidations earn no
points for anyone. See [Referrals and points](rewards.md).

The deployer gets no authority over the market's parameters and no claim on
its backing. What the lister posts as backing earns what any backing earns,
on the same terms as anybody else's (see
[How to underwrite a market](how-to-underwrite-a-market.md)).

Every reward is paid on trading that happened, and out of the protocol's cut.
A market nobody trades earns its opener nothing, and rent makes listing at
volume expensive. That is why no approval is needed.

{% hint style="warning" %}
The program is unaudited. Listing runs on devnet with test funds. Mainnet
listing stays off until it is audited.
{% endhint %}
