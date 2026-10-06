# Sessions

A tokenized stock trades around the clock. The stock it tracks does not. While
the exchange is closed, the only thing anchoring the token is its spot pool on
Solana, which is thin next to the exchange. So two limits tighten.

## Key figures

| Session | Maximum leverage | Open interest cap per side |
| --- | --- | --- |
| Regular | listed max | listed cap |
| Extended | listed max | listed cap |
| Closed | min(closed-session max, listed max) | listed cap × closed-session multiplier |

Maintenance margin does not change with the session. The depth tier on an
observed market applies in every session (see [Margining](margining.md)).

## How a session is set

1. Each market stores its session: regular, extended or closed.
2. Only the pool authority sets it, with `set_session`.
3. On devnet the venue's server checks the exchange calendar every 10 minutes
   and sends `set_session` for each stock market whose session changed.

Example: a stock market listed at 5x with a $2,000,000 cap per side, a 2x
closed-session maximum and a 2,500 bps multiplier. While the exchange is
closed, new opens are capped at 2x and each side at $500,000. Positions
already open keep their size; only new opens are held to the tighter limits.

## What does not change

* The token keeps trading, and the market keeps clearing every batch.
* The pool's spread follows the oracle's confidence in every session. A
  closed session widens it only when the oracle is less certain.
* What changes is how much of the pool a trader can direct at a price no
  exchange arbitrage is enforcing.

## Markets with no session

A market priced off a spot pool tracks a token, not an exchange listing. It
has no calendar, so it stays in the regular session. Site listings are created
with closed-session limits equal to the regular ones.
