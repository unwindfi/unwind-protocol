/// GET /api/x/logout -- clear the session and go back to the waitlist.
import { origin, redirect } from "./_oauth";
import { sessionCookie } from "./_session";

export function GET(req: Request) {
  const r = redirect(`${origin(req)}/waitlist`);
  r.headers.set("Set-Cookie", sessionCookie(null));
  return r;
}
