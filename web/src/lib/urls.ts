/*
 * The site's addresses that name something: a market, a vault, a search, a
 * referral code. Each is a path, never a query.
 *
 *   /trade/<SYMBOL>   a market's trade page
 *   /vault/<ID>       a vault, by market symbol or "pool"
 *   /list/<QUERY>     the list page, already searching
 *   /r/<CODE>         a referral link
 *
 * The older query shapes (`/trade?symbol=`, `/vault?id=`, `/list?q=`) still
 * open the same page: main.tsx rewrites them to these before the first
 * render. `?ref=` is still read on every page; `/r/<CODE>` becomes `/?ref=<CODE>`.
 */
export const TRADE = "/trade";
export const VAULT = "/vault";
export const LIST = "/list";
export const REF = "/r";

const under = (base: string, part?: string | null) =>
  part ? `${base}/${encodeURIComponent(part)}` : base;

/// The trade page for one market, or the terminal on its default market.
export const tradeHref = (symbol?: string | null) => under(TRADE, symbol);
/// One vault's page: a market symbol in its listed casing, or "pool".
export const vaultHref = (id: string) => under(VAULT, id);
/// The list page, opened searching for `query`.
export const listHref = (query?: string | null) => under(LIST, query?.trim());
/// A referral link, absolute, for sharing.
export const refHref = (code: string, origin = location.origin) => `${origin}${under(REF, code)}`;

/// The one segment after `base`, decoded: `/trade/hype` under TRADE gives "hype".
const partOf = (base: string, pathname: string): string | null => {
  const m = new RegExp(`^${base}/([^/]+)/?$`).exec(pathname);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
};

/// The market a trade path names, as typed; the terminal matches it against
/// the list without regard to case.
export const symbolFromPath = (pathname: string) => partOf(TRADE, pathname);
/// The vault a vault path names, as typed.
export const vaultFromPath = (pathname: string) => partOf(VAULT, pathname);
/// The search a list path carries.
export const queryFromPath = (pathname: string) => partOf(LIST, pathname);
/// The code a referral path carries.
export const refFromPath = (pathname: string) => partOf(REF, pathname);

/// Every `/trade/<X>` is the one trade route, and likewise for vaults and the
/// list.
export const routeKey = (path: string) => {
  const m = /^(\/(?:trade|vault|list))\/[^/]+$/.exec(path);
  return m ? m[1] : path;
};
