/*
 * Devnet is open to everyone, front page included.
 *
 * Every page, `/` too, is answered by the full build under `/unlocked/`, at
 * its own address, so the router in the app never learns it was moved. `/`
 * was the waitlist until devnet opened; it is the market list now.
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
  // Files at the root -- the favicon, robots, the manifest -- are the same
  // either way. A market's, vault's, search's or referral's page is never a
  // file, even when its name has a dot.
  if (/\.[^/]*$/.test(path) && !/^\/(trade|vault|list|r)\/[^/]+$/.test(path)) return next();
  // A link preview of one market gets that market's card; people get the app.
  const sym = path.match(/^\/trade\/([^/]+)$/)?.[1];
  if (sym && PREVIEWERS.test(req.headers.get("user-agent") ?? "")) return marketPreview(url, decodeURIComponent(sym));
  return rewrite(new URL("/unlocked/index.html", url));
}

/*
 * Link previewers: the crawlers X, Telegram, Discord, Slack and the rest send
 * to read a page's title and picture. They never run the app, so the page they
 * fetch has to carry its own tags.
 */
const PREVIEWERS = /Twitterbot|facebookexternalhit|Facebot|Discordbot|Slackbot|TelegramBot|LinkedInBot|WhatsApp|redditbot|Applebot|Embedly|SkypeUriPreview|Iframely|bingbot|Googlebot/i;

/// The app's page with one market's title, link and card in its share tags.
/// The card is drawn by the devnet server from live figures; the query is a
/// five-minute bucket so a fresh post shows fresh figures.
async function marketPreview(url: URL, sym: string) {
  const html = await (await fetch(new URL("/unlocked/index.html", url))).text();
  const safe = sym.replace(/[^A-Za-z0-9]/g, "").slice(0, 16);
  const img = `https://api.unwindfi.xyz/api/og/trade/${safe}.png?v=${Math.floor(Date.now() / 300_000)}`;
  const page = `https://unwindfi.xyz/trade/${safe}`;
  const out = html
    .replace(/<title>[^<]*<\/title>/, `<title>Trade ${safe} · unwind</title>`)
    .replace(/(property="og:title" content=")[^"]*/, `$1Trade ${safe} · unwind`)
    .replace(/(property="og:url" content=")[^"]*/, `$1${page}`)
    .replace(/(property="og:image" content=")[^"]*/, `$1${img}`)
    .replace(/(name="twitter:image" content=")[^"]*/, `$1${img}`);
  return new Response(out, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" } });
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
