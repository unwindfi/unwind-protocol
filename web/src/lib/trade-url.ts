/*
 * A market's address is `/trade/<SYMBOL>`.
 *
 * It used to be `/trade?symbol=<SYMBOL>`; links already out in that shape are
 * rewritten to this one before the first render (see main.tsx).
 */
export const TRADE = "/trade";

/// The trade page for one market, or the terminal on its default market.
export const tradeHref = (symbol?: string | null) =>
  symbol ? `${TRADE}/${encodeURIComponent(symbol)}` : TRADE;

/// The market a trade path names, as typed: `/trade/hype` gives "hype", and
/// the terminal matches it against the list without regard to case.
export const symbolFromPath = (pathname: string): string | null => {
  const m = /^\/trade\/([^/]+)\/?$/.exec(pathname);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
};

/// Every `/trade/<SYMBOL>` is the one trade route.
export const routeKey = (path: string) => (/^\/trade\/[^/]+$/.test(path) ? TRADE : path);
