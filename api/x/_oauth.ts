/*
 * OAuth 1.0a against X, by hand.
 *
 * 1.0a rather than 2.0 because of what each hands back. The 2.0 code exchange
 * returns a bearer token and nothing else, and learning who it belongs to
 * takes a call to /2/users/me -- which X's free tier rations to a couple of
 * dozen a day, so a waitlist on it would stop taking names before lunch. The
 * 1.0a access-token step returns the user id and handle in its own response,
 * so signing in is the whole exchange and no profile call is ever made.
 *
 * Nothing here is stored beyond the callback: the access token is discarded
 * once the handle is read. A waitlist has no business holding a key to
 * anyone's account.
 */
import { createHmac, randomBytes } from "node:crypto";

const REQUEST_TOKEN = "https://api.x.com/oauth/request_token";
const ACCESS_TOKEN = "https://api.x.com/oauth/access_token";
export const AUTHENTICATE = "https://api.x.com/oauth/authenticate";

/// RFC 3986 percent-encoding, which is stricter than encodeURIComponent.
const enc = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

function keys() {
  const key = process.env.X_API_KEY, secret = process.env.X_API_SECRET;
  if (!key || !secret) throw new Error("X_API_KEY and X_API_SECRET are not set");
  return { key, secret };
}

/// The Authorization header for one signed POST with no body parameters.
function authHeader(url: string, extra: Record<string, string>, tokenSecret = "") {
  const { key, secret } = keys();
  const p: Record<string, string> = {
    oauth_consumer_key: key,
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_version: "1.0",
    ...extra,
  };
  const base = Object.keys(p).sort().map((k) => `${enc(k)}=${enc(p[k])}`).join("&");
  const text = ["POST", enc(url), enc(base)].join("&");
  const sig = createHmac("sha1", `${enc(secret)}&${enc(tokenSecret)}`).update(text).digest("base64");
  p.oauth_signature = sig;
  return "OAuth " + Object.keys(p).sort().map((k) => `${enc(k)}="${enc(p[k])}"`).join(", ");
}

/// `a=1&b=2` to an object. By hand, because the TypeScript the build
/// machine picks up is the repo's 4.9, whose library cannot iterate the
/// built-in parser.
function form(body: string) {
  const out: Record<string, string> = {};
  for (const pair of body.split("&")) {
    if (!pair) continue;
    const i = pair.indexOf("=");
    const k = decodeURIComponent(i < 0 ? pair : pair.slice(0, i));
    out[k] = i < 0 ? "" : decodeURIComponent(pair.slice(i + 1).replace(/\+/g, " "));
  }
  return out;
}

async function post(url: string, auth: string) {
  const r = await fetch(url, { method: "POST", headers: { Authorization: auth } });
  const body = await r.text();
  if (!r.ok) throw new Error(`${url.split("/").pop()} ${r.status}: ${body.slice(0, 200)}`);
  return form(body);
}

/// Step one: a temporary token, tied to where X should send the user back.
export async function requestToken(callback: string) {
  const out = await post(REQUEST_TOKEN, authHeader(REQUEST_TOKEN, { oauth_callback: callback }));
  if (out.oauth_callback_confirmed !== "true") throw new Error("callback not confirmed");
  return { token: out.oauth_token, secret: out.oauth_token_secret };
}

/// Step three: trade the verifier for who this is.
export async function accessToken(token: string, secret: string, verifier: string) {
  const out = await post(ACCESS_TOKEN,
    authHeader(ACCESS_TOKEN, { oauth_token: token, oauth_verifier: verifier }, secret));
  return { id: out.user_id, handle: out.screen_name };
}

/// Where this deployment lives, from the request rather than configuration,
/// so previews and production each call back to themselves.
export function origin(req: Request) {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "";
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}`;
}

export const COOKIE = "x_oauth";

export function readCookie(req: Request) {
  const m = (req.headers.get("cookie") ?? "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

/// A redirect that also sets (or clears) the handshake cookie.
export function redirect(to: string, cookie?: string | null) {
  const h = new Headers({ Location: to });
  if (cookie !== undefined) {
    const v = cookie === null ? "" : encodeURIComponent(cookie);
    const age = cookie === null ? 0 : 600;
    h.set("Set-Cookie",
      `${COOKIE}=${v}; Path=/api/x; Max-Age=${age}; HttpOnly; Secure; SameSite=Lax`);
  }
  return new Response(null, { status: 302, headers: h });
}
