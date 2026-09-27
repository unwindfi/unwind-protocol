# Sessions

## Overview

Tokenized equities are the difficult case for a perpetual venue, and they
constitute most of the markets running today. The token trades continuously,
but the equity it tracks does not, and for most hours of most weeks the only
thing anchoring the token's price is its spot pool on Solana, which is thin
relative to the underlying exchange.

## Technical details

While the underlying session is closed, two limits tighten.

* Open interest per side is capped more tightly than during the open session.
* Maximum leverage is reduced.

The pool's quoted spread follows the oracle's reported confidence interval in
every session. A closed session usually widens it only because the oracle is
less certain.

The token itself continues to trade throughout. What changes is the quantity
of the pool's balance sheet a trader is permitted to direct at a price that
no arbitrageur is currently enforcing.

A market opened against an AMM pool has no exchange behind it and therefore
no session to track, so these limits do not apply to it.
