# Risks

## Overview

Trading on unwind can lose you everything you post as margin, and supplying
liquidity or backing can lose you everything you deposit. This page lists
where those losses come from and links to the page that states each rule in
full. Where this page and the program disagree, the program is right.

Nothing in these docs is investment advice.

## The program is unaudited

unwind runs as a Solana program that has not been audited. Every action is a
transaction you sign, and its outcome is whatever the program does with it. A
bug in the program can lose funds that no rule on this page protects.

## Leverage and liquidation

Positions are leveraged. A position whose margin falls under its market's
maintenance margin can be closed by any account, at the mark, and the margin
behind it is lost. Liquidation is permissionless, so it does not wait for a
keeper. The fee comes out of what is left of the position, never out of the
pool.

Maximum leverage is set per market. For a market priced off a spot pool it
follows that pool's sustained depth: 2x under $10k, 3x to $50k, 4x to $250k,
5x above. See [Margining](margining.md) and
[Liquidations](liquidations.md).

## Prices

A market is priced by a Pyth feed or by a spot pool the mark keeper observes.
Positions are valued and liquidated against that mark, not the last clearing
price, so a wrong or stale mark means wrong valuations and wrong
liquidations. Orders pause when the feed is older than the market allows. A
market tracking a thinly traded asset can be moved by moving its spot pool.
See [Price sources](price-sources.md).

## Keepers

Batches are cleared and non-Pyth marks are pushed by keepers. If they stop,
batches stop clearing and those marks stop updating, and orders pause rather
than fill at an old price. Liquidation does not depend on them.

## Where losses go

A market's losses are paid in order: the backing posted behind it, then pool
liquidity up to the market's loss budget, then the insurance fund. A winner is
never paid past its market's budget: when the market cannot cover every
winner, each winning close is paid the same fair share of its profit and the
rest is not paid, so a profitable position can be paid less than its paper
gain. Backers can withdraw at any time, which lowers the budget winners are
paid from. See [Loss budget](loss-budget.md) and
[Profit haircuts](auto-deleveraging.md).

## Backing and the pool

Backers take a market's losses first, up to what they posted, and are made
whole from later gains only up to what was drawn. Pool liquidity takes the
losses backers do not, up to each market's budget, across every market at
once. Neither capital nor yield is guaranteed, and withdrawing pays the mix of
assets the pot holds. See [The pool](pool.md) and
[How to underwrite a market](how-to-underwrite-a-market.md).

## Liquidity

Orders clear in batches, and a batch fills only what crosses. A thin market
can leave an order unfilled, or fill it far from the asset's reference price.
The pool fills only what makers leave, and only within the market's budget.
See [The auction](auction.md).

## Listing

Anyone can open a market. A market existing on unwind is not an endorsement of
the asset it tracks, its issuer, or the account that opened it.

## Devnet

Devnet settles in test USDC against devnet copies of tokens marked at Jupiter
prices. It carries no real value, and its parameters can change or be reset.
See [Devnet](devnet.md).

## Assets and jurisdictions

Tokenised stocks (xStocks) are not available to US persons. unwind is not
affiliated with Backed, Jupiter, Pyth or the issuers of the assets its markets
track. You are responsible for the rules where you live.
