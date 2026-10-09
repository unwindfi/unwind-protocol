/*
 * Whether the program would refuse an open, asked before anything is signed.
 *
 * Positions do not flip. An open on the side a wallet already holds adds to
 * that position, and the program books it like any other. An open on the
 * other side is refused with PositionAlreadyOpen, and so is one against an
 * opening order of the wallet's own on the other side that is still in the
 * collecting batch (`Batch::push`). Shared by the server, which asks it from
 * the chain before building the transaction, and the order ticket, which
 * asks it from its live reads to disable the button and say why.
 */

/// The wallet's position on the market, in USD. `closing` is how much of it
/// is already promised to a close resting in the batch.
export type HeldPosition = { isLong: boolean; size: number; closing: number };

/// One of the wallet's own orders in the collecting batch.
export type OwnOrder = { isBid: boolean; reduceOnly: boolean };

export type OpenRefusal = {
  /// `held`: a position on the other side. `closing`: one, but all of it is
  /// closing in this batch. `queued`: an opening order on the other side is
  /// still in this batch.
  kind: "held" | "closing" | "queued";
  message: string;
};

const sideName = (isLong: boolean) => (isLong ? "long" : "short");

/// Why an open of `isLong` on `symbol` would be refused, or null when it
/// would not be. `inBatch` is false for a limit, which is placed outside any
/// batch and asked only about the position.
export function openRefusal(
  symbol: string,
  isLong: boolean,
  pos: HeldPosition | null,
  mine: OwnOrder[],
  inBatch = true,
): OpenRefusal | null {
  if (pos && pos.size > 0 && pos.isLong !== isLong) {
    // A cent of rounding is not a position left open.
    return pos.closing >= pos.size - 0.01
      ? {
          kind: "closing",
          message: `Your ${sideName(pos.isLong)} on ${symbol} closes next batch. Open the ${sideName(isLong)} after it fills.`,
        }
      : {
          kind: "held",
          message: `You already hold a ${sideName(pos.isLong).toUpperCase()} on ${symbol}. Close or reduce it first.`,
        };
  }
  const crossing = inBatch && mine.find((o) => !o.reduceOnly && o.isBid !== isLong);
  if (crossing) {
    return {
      kind: "queued",
      message: `Your ${sideName(crossing.isBid)} order on ${symbol} is still in this batch. Open the ${sideName(isLong)} after it settles.`,
    };
  }
  return null;
}
