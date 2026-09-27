# How to open a market

## Overview

Opening a market requires no approval and no relationship with the protocol.
It is a single signed transaction, and the account that sends it receives no
special rights over the market afterwards.

A market that has been opened is tradeable once it has an established price
and a loss budget. From the site, both arrive in the listing transaction
itself where the tracked pool allows it, so a listing does not end on a
market nobody can trade.

## Steps

1. Find the token. The site searches by ticker, name or mint, and reads every
   USDC or USDT pool the token has on Raydium concentrated liquidity and on
   Meteora DLMM. The most liquid pool is picked by default. An asset with a
   Pyth feed can be pointed at that feed instead.
2. Review the limits. Open interest per side defaults to what the pool's depth
   supports, capped at 50,000 USDC and floored at 1,000 USDC. Leverage follows
   the pool's depth (see [Margining](margining.md)): the market opens at 2x
   and rises, up to 5x, as the depth holds. Both can be lowered under
   Advanced; the leverage set there is a ceiling the depth cannot lift past.
3. Post the backing. The site lists and backs in one transaction, with at
   least 100 USD of backing in USDC, USDT or SOL. The program itself will list
   an unbacked market; the site does not.
4. Confirm that you understand the backing takes the market's losses first,
   up to what it holds. The site will not sign until this is ticked.
5. Sign, paying the rent of the accounts the listing creates.

## When trading opens

At once. The venue's mark keeper prices every new market on its next pass,
within about 25 seconds of listing, and the market trades from that first
price. There is no warm-up period. See [Price sources](price-sources.md).

## Units

A token worth less than a cent is quoted per thousand, per million or per
billion tokens, the smallest unit that is worth a cent again. Bonk at
0.0000038 USD trades as 3.81 USD per 1M. A token worth a cent or more trades
one token at a time.

## What opening a market earns

A share of what the market is used for, and nothing before that. The opener
(the market's `deployer`) is owed 10 percent of every trading fee paid on the
market, in USDC, and 0.1 points per dollar traded on it. They also trade that
one market at half the fee. See [Referrals and points](rewards.md).

The opener receives no authority over the market's parameters and no claim on
its backing. What the lister posts as backing earns what any backing earns, on
the same terms as anybody else's. See
[How to underwrite a market](how-to-underwrite-a-market.md).

Every one of these rewards is paid on trading that has actually happened, and
out of the protocol's share of the fee rather than anyone else's. A market
nobody trades earns its opener nothing, so there is still nothing to gain by
listing assets speculatively, and the rent makes doing so at volume
expensive. That is why no approval process is required.

{% hint style="warning" %}
The program is unaudited. Listing runs on devnet with test funds; mainnet
listing stays off until it is audited.
{% endhint %}
