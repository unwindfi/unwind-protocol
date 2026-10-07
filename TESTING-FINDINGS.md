# Testing findings

Bugs and gaps the test-depth pass turned up. Each has a test that shows it,
marked skipped (TypeScript) or ignored (Rust) with a reference here, so the
suites stay green until it is fixed.

## 1. The keeper's circuit breaker holds a move of exactly its limit

- **Where:** `breaker` in `scripts/server-logic.ts` (moved unchanged from
  `scripts/server.ts`).
- **Input:** a mark on chain of 100 and a next reading of 110, or 1,000,000
  and 1,100,000: a move of exactly `BREAKER_PCT` (10%).
- **Expected:** passed through. The comment says a mark *more than*
  `BREAKER_PCT` from the one on chain is held.
- **Actual:** held for a pass. `Math.abs(next / onChain - 1) * 100` is
  `10.000000000000009` in floating point, which is more than 10. A 10% fall
  reads as `9.999999999999998` and passes, so the two directions disagree.
- **Effect:** small. An exact 10% rise is pushed one pass late; nothing is
  mispriced.
- **Suggested fix:** compare in integers or with a tolerance, for example
  `Math.abs(next - onChain) * 100 <= BREAKER_PCT * onChain`.
- **Test:** `passes a move of exactly the limit (finding 1)` in
  `scripts/server-logic.test.ts`, skipped.
