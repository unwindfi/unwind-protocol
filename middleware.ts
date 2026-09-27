/*
 * The lock in front of the unfinished pages.
 *
 * Without the cookie from `/code` the site is the waitlist: `/` is served as
 * built, `/unlocked/*` does not exist, and any other page redirects home,
 * which is what `vercel.json` used to do on its own. With the cookie every
 * page is answered by the full build under `/unlocked/`, at its own address,
 * so the router in the app never learns it was moved.
 */
import { unlocked } from "./api/_code";

export const config = {
  matcher: ["/((?!api/|assets/|logos/|audio/).*)"],
};

const next = () => new Response(null, { headers: { "x-middleware-next": "1" } });
const rewrite = (to: URL) => new Response(null, { headers: { "x-middleware-rewrite": to.href } });
const redirect = (to: URL) => new Response(null, { status: 307, headers: { location: to.href } });

export default async function middleware(req: Request) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/(.)\/$/, "$1");
  const open = await unlocked(req);

  if (path.startsWith("/unlocked/")) {
    if (!open) return new Response("Not found", { status: 404 });
    // Only the build itself is copied there; the favicon and the rest of
    // `public` it points at are the ones at the root.
    return /^\/unlocked\/(assets\/|index\.html$)/.test(path)
      ? next()
      : rewrite(new URL(path.slice("/unlocked".length) + url.search, url));
  }
  if (path === "/code") {
    return open
      ? redirect(new URL("/markets", url))
      : new Response(page(url.searchParams.has("wrong")), {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        });
  }
  // Files at the root -- the favicon, robots, the manifest -- are the same either way.
  if (/\.[^/]*$/.test(path)) return next();
  if (open) return rewrite(new URL("/unlocked/index.html", url));
  if (path !== "/") return redirect(new URL(`/${url.search}`, url));
  return next();
}

const page = (wrong: boolean) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>unwind · code</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px;
    background: #0b0b0c; color: #ededed;
    font: 15px/1.5 Inter, ui-sans-serif, system-ui, -apple-system, sans-serif;
  }
  form { width: 100%; max-width: 340px; display: grid; gap: 12px; }
  h1 { margin: 0 0 4px; font-size: 20px; font-weight: 600; letter-spacing: -0.01em; }
  p { margin: 0 0 8px; color: #8a8a8f; }
  input, button { font: inherit; height: 44px; border-radius: 10px; }
  input {
    width: 100%; padding: 0 14px; color: inherit; background: #151517;
    border: 1px solid ${wrong ? "#e5484d" : "#2a2a2e"}; outline: none;
  }
  input:focus { border-color: #5b5bd6; }
  button { border: 0; background: #ededed; color: #0b0b0c; font-weight: 600; cursor: pointer; }
  .err { color: #e5484d; font-size: 13px; margin: -4px 0 0; }
</style>
</head>
<body>
<form method="post" action="/api/code">
  <h1>unwind</h1>
  <p>Enter the code to see the whole site.</p>
  <input type="password" name="password" placeholder="Password" autocomplete="current-password" autofocus required>
  ${wrong ? `<p class="err">That code is not right.</p>` : ""}
  <button type="submit">Open</button>
</form>
</body>
</html>`;
