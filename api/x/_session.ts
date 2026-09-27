/*
 * Who is signed in, as a cookie the browser cannot read or forge.
 *
 * The value is `id.handle.signature`, signed with a key derived from the X
 * consumer secret -- one secret to manage rather than two, and the session
 * is worth nothing without the app it belongs to anyway. HttpOnly, so the
 * page learns who it is by asking /api/me rather than by reading the cookie.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION = "wl_session";
const DAYS = 30;

function key() {
  const s = process.env.X_API_SECRET;
  if (!s) throw new Error("X_API_SECRET is not set");
  return createHmac("sha256", "unwind-waitlist-session").update(s).digest();
}
const sign = (body: string) => createHmac("sha256", key()).update(body).digest("base64url");

export type Who = { id: string; handle: string };

export function sessionCookie(who: Who | null) {
  const v = who ? `${who.id}.${who.handle}.${sign(`${who.id}.${who.handle}`)}` : "";
  const age = who ? DAYS * 86400 : 0;
  return `${SESSION}=${v}; Path=/; Max-Age=${age}; HttpOnly; Secure; SameSite=Lax`;
}

export function readSession(req: Request): Who | null {
  const m = (req.headers.get("cookie") ?? "").match(new RegExp(`(?:^|;\\s*)${SESSION}=([^;]+)`));
  if (!m) return null;
  const [id, handle, sig] = m[1].split(".");
  if (!id || !handle || !sig) return null;
  const want = Buffer.from(sign(`${id}.${handle}`)), got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  return { id, handle };
}
