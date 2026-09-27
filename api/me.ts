/*
 * GET /api/me -- who is signed in, and how their referrals stand.
 *
 * The page asks this on load. Signed out is a 401 and the page shows the
 * join button; signed in is the handle, the referral link, and everyone
 * it has brought in, newest first, read straight off the listing's
 * pathnames.
 */
import { list } from "./x/_blob";
import { origin } from "./x/_oauth";
import { readSession } from "./x/_session";

export async function GET(req: Request) {
  const who = readSession(req);
  if (!who) return new Response(null, { status: 401 });
  const rows = await list(req, `waitlist/ref/${who.handle.toLowerCase()}/`);
  const referrals = rows
    .map((r) => {
      const m = r.pathname.match(/\/([^/]+)-(\d+)-([A-Za-z0-9_]+)\.json$/);
      return m ? { ts: m[1], id: m[2], handle: m[3] } : null;
    })
    .filter((x): x is { ts: string; id: string; handle: string } => x !== null)
    .sort((a, b) => (a.ts < b.ts ? 1 : -1));
  return Response.json(
    { ...who, link: `${origin(req)}/waitlist?ref=${who.handle}`, referrals },
    { headers: { "cache-control": "no-store" } },
  );
}
