/*
 * The key to the unfinished site, as a cookie.
 *
 * Before launch the public build is the waitlist and nothing else. A second
 * build with every page in it sits under `/unlocked/`, and the middleware
 * only lets a browser reach it with this cookie. The password lives in
 * `CODE_PASSWORD`; the cookie is an HMAC of it rather than the password
 * itself, so changing the password turns every old cookie away.
 *
 * Web Crypto rather than `node:crypto`, because the middleware that reads
 * this runs on the edge: it sits in front of every page and every chunk of
 * the unlocked build, and a round trip to one function region per file was
 * most of the site's load time for anyone far from it.
 */
export const CODE = "unwind_code";
const DAYS = 30;
const enc = new TextEncoder();

async function token() {
  const p = process.env.CODE_PASSWORD;
  if (!p) return null;
  const key = await crypto.subtle.importKey(
    "raw", enc.encode("unwind-code"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(p)));
  return btoa(String.fromCharCode(...sig)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/// Constant time in the length of the secret, so a wrong guess learns nothing
/// from how long it took to be refused.
const same = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};

export function passes(password: string) {
  const p = process.env.CODE_PASSWORD;
  return !!p && same(password, p);
}

export async function unlocked(req: Request) {
  const m = (req.headers.get("cookie") ?? "").match(new RegExp(`(?:^|;\\s*)${CODE}=([^;]+)`));
  if (!m) return false;
  const want = await token();
  return !!want && same(m[1], want);
}

export async function codeCookie() {
  return `${CODE}=${await token()}; Path=/; Max-Age=${DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`;
}
