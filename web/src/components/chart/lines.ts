import type { Account, Position } from "@/lib/api";

/// A level drawn across the chart: where a position was opened, where it gets
/// liquidated, and the prices its standing orders fire at.
export type ChartLineKind = "entry" | "liq" | "tp" | "sl" | "limit" | "drawn";
export interface ChartLine { kind: ChartLineKind; price: number; title?: string }

export const TITLES: Record<ChartLineKind, string> = {
  entry: "Entry", liq: "Liq", tp: "TP", sl: "SL", limit: "Limit", drawn: "",
};

export function positionLevels(p: Position): ChartLine[] {
  const out: ChartLine[] = [{ kind: "entry", price: p.entry }];
  if (p.liqPrice > 0) out.push({ kind: "liq", price: p.liqPrice });
  return out;
}

/*
 * Everything the account has riding on one market, as chart lines.
 *
 * A close order is a take-profit when it fires on the side the position gains
 * on: above the price for a long, below it for a short. That is the same
 * rule the server uses to set `triggerAbove` when the order is placed, read
 * backwards. An open order is a limit entry.
 */
export function accountLines(account: Account | null | undefined, symbol: string): ChartLine[] {
  if (!account) return [];
  const p = account.positions[symbol];
  const out = p ? positionLevels(p) : [];
  for (const o of account.orders) {
    if (o.symbol !== symbol || !(o.triggerPrice > 0)) continue;
    const kind: ChartLineKind = o.kind === 1 ? "limit"
      : o.triggerAbove === o.isLong ? "tp" : "sl";
    out.push({ kind, price: o.triggerPrice });
  }
  return out;
}
