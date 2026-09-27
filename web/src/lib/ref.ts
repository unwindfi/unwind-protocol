/*
 * The referral code a visitor arrived with.
 *
 * Read off `?ref=` on whatever page they landed on and kept, because the page
 * a link opens is rarely the page someone trades from. It is sent with the
 * wallet's first order, and the server drops it quietly if it names nobody,
 * names the wallet itself, or the wallet already has a referrer. So a stale
 * or mistyped code can never stop an order.
 */
const REF_KEY = "unwind.ref";
export function rememberRef(search = location.search) {
  const ref = new URLSearchParams(search).get("ref")?.toLowerCase();
  if (!ref || !/^[a-z0-9_-]{3,16}$/.test(ref)) return;
  try { localStorage.setItem(REF_KEY, ref); } catch { /* private window */ }
}
export function storedRef(): string | null {
  try { return localStorage.getItem(REF_KEY); } catch { return null; }
}
