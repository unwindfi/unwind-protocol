/*
 * GET /api/x/callback -- X sends the visitor back here.
 *
 * Checks the returned token against the one in the cookie, trades the
 * verifier for the user's id and handle, records them, credits whoever
 * referred them, signs them in, and returns them to the waitlist. The
 * handshake cookie is cleared either way.
 *
 * Records are pathnames, not contents. `waitlist/x/<id>.json` says a user
 * exists; `waitlist/ref/<referrer>/<time>-<id>-<handle>.json` says who they
 * brought in and when, so a referrer's progress is one listing with nothing
 * to open. A referral is credited once, on the first sign-in, and never to
 * oneself: signing in again is not joining again.
 */
import { list, put } from "./_blob";
import { accessToken, origin, readCookie, redirect } from "./_oauth";
import { sessionCookie } from "./_session";

export async function GET(req: Request) {
  const site = origin(req);
  const back = (q: string, session?: string) => {
    const r = redirect(`${site}/${q ? `?${q}` : ""}`, null);
    if (session) r.headers.append("Set-Cookie", session);
    return r;
  };
  const url = new URL(req.url);
  if (url.searchParams.get("denied")) return back("error=You+cancelled+on+X");
  const token = url.searchParams.get("oauth_token");
  const verifier = url.searchParams.get("oauth_verifier");
  const cookie = readCookie(req);
  if (!token || !verifier || !cookie) return back("error=The+sign-in+did+not+complete");
  const [expected, secret, ref = ""] = cookie.split(":");
  if (token !== expected) return back("error=The+sign-in+did+not+match");
  try {
    const { id, handle } = await accessToken(token, secret, verifier);
    const seen = (await list(req, `waitlist/x/${id}.json`)).length > 0;
    const ts = new Date().toISOString();
    await put(req, `waitlist/x/${id}.json`,
      { id, handle, ref: ref || null, source: "waitlist", ts, ...(seen ? { again: true } : {}) });
    if (!seen && ref && ref.toLowerCase() !== handle.toLowerCase()) {
      await put(req, `waitlist/ref/${ref.toLowerCase()}/${ts}-${id}-${handle}.json`, { id, handle, ts });
    }
    return back("", sessionCookie({ id, handle }));
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return back(`error=${encodeURIComponent(why)}`);
  }
}
