/*
 * Links, search tags and share cards, once a day (LINKS_EVERY_HOURS).
 *
 * Links: the site's pages are drawn by the app, so they are read in the
 * browser (the nav, the footer and the page itself), and an address on the
 * site is broken when it draws the not-found page. The docs site serves its
 * pages whole, so those are fetched and their links read from the HTML.
 * Breadth first from both front pages, at most LINKS_MAX addresses in all,
 * internal only (www, the bare domain, docs, the API). Each address is
 * asked with HEAD, then GET when HEAD is refused. A 404 or a 5xx is filed
 * with the page it was linked from.
 *
 * Search tags: every main route needs a title and a meta description, and
 * og:title, og:description and og:image, as the app leaves them in the
 * page; titles and descriptions should differ between routes. The og:image
 * itself must load as an image.
 *
 * Share cards: every listed market's card, at /api/og/trade/<SYM>.png on the
 * API, and the card a link previewer is actually given (middleware.ts hands
 * a previewer's request for /trade/<SYM> a page whose og:image is that
 * card), must answer 200 with an image.
 */
import type { Browser, Page } from "playwright-core";
import { config } from "../config";
import { routeOf } from "../detectors";
import type { Market } from "../session";
import { routes } from "../survey";
import { api, fileIssue, timed } from "./common";

const SITE_HOSTS = new Set(["www.unwindfi.xyz", "unwindfi.xyz"]);
const hostOf = (u: string) => { try { return new URL(u).host; } catch { return ""; } };

interface Found { url: string; from: string }

/// Where an issue about a page belongs: the site's route, or "docs:/path".
const placeOf = (u: string) => {
  try {
    const x = new URL(u);
    if (x.host === hostOf(config.docsUrl)) return `docs:${x.pathname}`;
    return routeOf(x.pathname);
  } catch { return u; }
};

const clean = (href: string, base: string): string | null => {
  try {
    const u = new URL(href, base);
    if (!/^https?:$/.test(u.protocol)) return null;
    u.hash = "";
    return u.toString();
  } catch { return null; }
};

const internal = (u: string) => {
  const h = hostOf(u);
  return SITE_HOSTS.has(h) || h === hostOf(config.docsUrl) || h === hostOf(config.checksApiUrl) || h === hostOf(config.baseUrl);
};
const onSite = (u: string) => SITE_HOSTS.has(hostOf(u)) || hostOf(u) === hostOf(config.baseUrl);
const onDocs = (u: string) => hostOf(u) === hostOf(config.docsUrl);

/// HEAD, then GET when HEAD is refused or not answered.
async function status(url: string): Promise<{ status: number; error?: string; type: string }> {
  const h = await timed(url, { method: "HEAD", ms: 15_000 });
  if (h.status && ![403, 405, 501].includes(h.status) && h.status < 500) return h;
  const g = await timed(url, { ms: 20_000 });
  return g;
}

interface Tags { title: string; description: string; ogTitle: string; ogDescription: string; ogImage: string }

const TAGS = (): Tags => {
  const meta = (sel: string) => document.querySelector(sel)?.getAttribute("content")?.trim() ?? "";
  return {
    title: document.title.trim(),
    description: meta('meta[name="description"]'),
    ogTitle: meta('meta[property="og:title"]'),
    ogDescription: meta('meta[property="og:description"]'),
    ogImage: meta('meta[property="og:image"]'),
  };
};

const tagsFromHtml = (html: string): Tags => {
  const meta = (attr: string, v: string) =>
    new RegExp(`<meta[^>]+${attr}="${v}"[^>]*content="([^"]*)"`, "i").exec(html)?.[1]
    ?? new RegExp(`<meta[^>]+content="([^"]*)"[^>]*${attr}="${v}"`, "i").exec(html)?.[1] ?? "";
  return {
    title: (/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] ?? "").trim(),
    description: meta("name", "description"), ogTitle: meta("property", "og:title"),
    ogDescription: meta("property", "og:description"), ogImage: meta("property", "og:image"),
  };
};

/// Renders a site page and reads its links, its tags and whether it is the
/// not-found page.
async function render(page: Page, url: string) {
  const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => null);
  await page.waitForFunction(() => (document.body?.innerText ?? "").trim().length > 40, undefined, { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(1_200);
  const r = await page.evaluate(() => ({
    links: Array.from(document.querySelectorAll("a[href]")).map((a) => a.getAttribute("href")!),
    missing: /^Nothing here\.?$/.test(document.querySelector("main h1")?.textContent?.trim() ?? ""),
  })).catch(() => ({ links: [] as string[], missing: false }));
  const tags = await page.evaluate(TAGS).catch(() => null);
  return { status: res?.status() ?? 0, ...r, tags };
}

export async function run(browser: Browser): Promise<{ ok: boolean; summary: string }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US", serviceWorkers: "block" });
  await context.route(/\/api\/(faucet|devnet-copy|tx\/send|seen)(\?|$)/, (r) => r.abort("blockedbyclient"));
  // Pictures, fonts and media are not links; a rendered page needs its
  // scripts and data only.
  await context.route("**/*", (r) => (["image", "media", "font"].includes(r.request().resourceType()) ? r.abort() : r.continue()));
  const page = await context.newPage();
  let filed = 0, checked = 0;
  const file = async (i: Parameters<typeof fileIssue>[0]) => { filed++; await fileIssue({ step: "links", ...i }); };
  try {
    // ---------------------------------------------------------- links
    const seen = new Map<string, string>(); // url -> the page it was first found on
    const queue: Found[] = [];
    const add = (url: string | null, from: string) => {
      if (!url || !internal(url) || seen.has(url) || seen.size >= config.linksMax) return;
      seen.set(url, from);
      queue.push({ url, from });
    };
    const main = (await routes()).filter((r) => !/no-such-page/.test(r));
    for (const r of main) add(config.baseUrl + r, "(start)");
    add(config.docsUrl + "/", "(start)");
    const siteTags = new Map<string, Tags>();
    while (queue.length) {
      const { url, from } = queue.shift()!;
      checked++;
      if (onSite(url)) {
        // The API's own paths on the site's host are files or JSON, not pages.
        if (/\/(api|assets|logos)\//.test(new URL(url).pathname) || /\.[a-z0-9]{2,5}$/i.test(new URL(url).pathname)) {
          const s = await status(url);
          if (s.status === 404 || s.status >= 500 || s.status === 0) await file({ type: "broken-link", severity: s.status >= 500 ? "high" : "medium", route: placeOf(from), message: `${url} answered ${s.status || s.error} (linked from ${from})`, key: `link ${new URL(url).pathname}` });
          continue;
        }
        const r = await render(page, url);
        if (r.missing || r.status === 404 || r.status >= 500 || r.status === 0) {
          await file({ type: "broken-link", severity: r.status >= 500 ? "high" : "medium", route: placeOf(from),
            message: `${url} ${r.missing ? "shows the not-found page" : `answered ${r.status}`} (linked from ${from})`, key: `link ${new URL(url).pathname}` });
          continue;
        }
        if (r.tags && main.some((m) => config.baseUrl + m === url)) siteTags.set(new URL(url).pathname, r.tags);
        for (const h of r.links) add(clean(h, url), url);
      } else if (onDocs(url)) {
        const g = await timed(url, { ms: 20_000 });
        if (g.status === 404 || g.status >= 500 || g.status === 0) {
          await file({ type: "broken-link", severity: g.status >= 500 ? "high" : "medium", route: placeOf(from),
            message: `${url} answered ${g.status || g.error} (linked from ${from})`, key: `link ${url.replace(/^https?:\/\//, "")}` });
          continue;
        }
        if (/text\/html/.test(g.type)) {
          for (const m of g.text.matchAll(/<a\b[^>]*\shref="([^"]+)"/g)) add(clean(m[1].replace(/&amp;/g, "&"), url), url);
          const t = tagsFromHtml(g.text);
          if (!t.title) await file({ type: "seo-missing", severity: "low", route: placeOf(url), message: `${url} has no <title>`, key: "docs title" });
          if (!t.description) await file({ type: "seo-missing", severity: "low", route: placeOf(url), message: `${url} has no meta description`, key: "docs description" });
        }
      } else {
        // The API's host: anything linked there is a file or a JSON answer.
        const s = await status(url);
        if (s.status === 404 || s.status >= 500 || s.status === 0) await file({ type: "broken-link", severity: s.status >= 500 ? "high" : "medium", route: placeOf(from), message: `${url} answered ${s.status || s.error} (linked from ${from})`, key: `link ${url.replace(/^https?:\/\//, "")}` });
      }
    }

    // ---------------------------------------------------------- tags
    const need: [keyof Tags, string][] = [["title", "a title"], ["description", "a meta description"], ["ogTitle", "og:title"], ["ogDescription", "og:description"], ["ogImage", "og:image"]];
    const images = new Set<string>();
    for (const [route, t] of siteTags) {
      for (const [k, what] of need) {
        if (!t[k]) await file({ type: "seo-missing", severity: k === "ogImage" ? "medium" : "low", route: routeOf(route), message: `${route} has no ${what}`, key: `seo ${k}` });
      }
      if (t.ogImage) images.add(t.ogImage);
    }
    for (const k of ["title", "description"] as const) {
      const by = new Map<string, string[]>();
      for (const [route, t] of siteTags) if (t[k]) by.set(t[k], [...(by.get(t[k]) ?? []), route]);
      for (const [v, rs] of by) {
        if (rs.length < 2) continue;
        await file({ type: "seo-duplicate", severity: "low", route: "(every page)",
          message: `${rs.length} routes share the ${k} "${v.slice(0, 80)}": ${rs.join(", ")}`, key: `dup ${k}` });
      }
    }
    for (const img of images) {
      const r = await timed(img, { ms: 20_000 });
      if (r.status !== 200 || !/^image\//.test(r.type)) {
        await file({ type: "share-card", severity: "medium", route: "(every page)", message: `og:image ${img} answered ${r.status || r.error} (${r.type || "no type"})`, key: `og image ${img.split("?")[0]}` });
      }
    }

    // ---------------------------------------------------------- share cards
    const markets = ((await api<Market[]>("/api/markets")) ?? []).filter((m) => !m.hidden);
    let cards = 0;
    for (const m of markets) {
      const sym = m.symbol.replace(/[^A-Za-z0-9]/g, "");
      const direct = await timed(`${config.checksApiUrl}/api/og/trade/${sym}.png`, { ms: 30_000 });
      cards++;
      if (direct.status !== 200 || !/^image\//.test(direct.type)) {
        await file({ type: "share-card", severity: "medium", route: "/trade/:sym",
          message: `${m.symbol}'s share card /api/og/trade/${sym}.png answered ${direct.status || direct.error} (${direct.type || "no type"})`, key: "og card direct" });
        continue;
      }
      // What X or Telegram is handed for a link to the market.
      const html = await timed(`${config.baseUrl}/trade/${encodeURIComponent(m.symbol)}`, { ua: "Twitterbot/1.0", ms: 20_000 });
      const og = tagsFromHtml(html.text).ogImage.replace(/&amp;/g, "&");
      if (!og.includes(`/api/og/trade/${sym}.png`)) {
        await file({ type: "share-card", severity: "medium", route: "/trade/:sym",
          message: `A link previewer asking for /trade/${m.symbol} gets og:image "${og.slice(0, 120) || "none"}", not its market card`, key: "og card tag" });
        continue;
      }
      const img = await timed(og, { ms: 30_000 });
      if (img.status !== 200 || !/^image\//.test(img.type)) {
        await file({ type: "share-card", severity: "medium", route: "/trade/:sym",
          message: `${m.symbol}'s card as previewers see it (${og}) answered ${img.status || img.error} (${img.type || "no type"})`, key: "og card previewer" });
      }
    }
    return { ok: filed === 0, summary: `links: ${checked} addresses, ${siteTags.size} routes' tags, ${cards} share cards; ${filed} issues` };
  } finally {
    await context.close().catch(() => undefined);
  }
}
