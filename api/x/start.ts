/*
 * GET /api/x/start -- the "Connect X" button lands here.
 *
 * Asks X for a request token, remembers its secret in a short-lived cookie
 * scoped to these two routes, and sends the visitor to X to approve. If they
 * arrived through someone's referral link, that handle rides along in the
 * same cookie so the callback can credit it. On failure it sends them back
 * to the waitlist with a reason rather than showing them a JSON error from
 * a route they never meant to visit.
 */
import { AUTHENTICATE, origin, redirect, requestToken } from "./_oauth";

export async function GET(req: Request) {
  const site = origin(req);
  // A handle is letters, digits and underscores; anything else is not a
  // referral and is dropped rather than stored.
  const ref = (new URL(req.url).searchParams.get("ref") ?? "").replace(/^@/, "");
  const safeRef = /^[A-Za-z0-9_]{1,15}$/.test(ref) ? ref : "";
  try {
    const { token, secret } = await requestToken(`${site}/api/x/callback`);
    return redirect(`${AUTHENTICATE}?oauth_token=${encodeURIComponent(token)}`,
      `${token}:${secret}:${safeRef}`);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return redirect(`${site}/?error=${encodeURIComponent(why)}`);
  }
}
