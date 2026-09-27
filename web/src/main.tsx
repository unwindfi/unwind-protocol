import {
  StrictMode, Suspense, lazy, useEffect, useState,
  type ComponentType,
} from "react";
import { createRoot } from "react-dom/client";
import { Analytics } from "@vercel/analytics/react";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "./index.css";
import WaitlistPage from "./site/Waitlist";
import { rememberRef } from "./lib/ref";

/*
 * The site and the app behind one entry, split by path.
 *
 * These used to be real navigations: no router, a document load per page,
 * each page its own lazy chunk. The chunking was right and is kept -- the
 * marketing pages still never download the chart library or the wallet
 * adapters -- but the document load was not. Moving from the market list to
 * the market you just clicked threw away a warm process to rebuild the same
 * header, refetch the same market list and reconnect the same wallet, for a
 * page that shares both ends of itself with the one you came from.
 *
 * So this is a router, but only the part of one that is load-bearing: a path
 * in state, a click handler that catches links this table knows, and
 * popstate. No matching, no params, no nested outlets -- the paths are a
 * fixed list, and anything not on it is still a real navigation, which is
 * what keeps external links, downloads and modified clicks behaving exactly
 * as the browser intends.
 */
type Loader = () => Promise<{ default: ComponentType }>;

/*
 * Before launch the site is one page.
 *
 * The waitlist is the front door now, so it answers on `/` rather than
 * sitting a click inside a landing page written for a venue that is not
 * open. Everything else -- the landing page, markets, the fee and mechanism
 * pages, the trade app -- is unfinished in public, and a visitor who finds
 * it judges the product by it.
 *
 * `VITE_UNLOCK=1` brings the rest back, which is how they are worked on. Dev
 * is always unlocked.
 *
 * This hides the pages; it does not protect them. Their chunks are still
 * built and still served, so anyone reading the bundle can find and load
 * one. That is the right trade for pages whose only problem is that they are
 * half-written, and the wrong one for anything that must stay secret.
 */
const UNLOCKED = import.meta.env.DEV || import.meta.env.VITE_UNLOCK === "1";

/// Before launch the waitlist is the only page, so it ships in the main bundle
/// rather than a chunk fetched after it: one round trip less to first paint.
const WAITLIST: Loader = async () => ({ default: WaitlistPage });

/*
 * The two trees that carry the wallet adapters are defined inside this
 * ternary rather than as entries added to it, and that placement is what
 * makes the lock real. `UNLOCKED` is a constant once the flag is not set, so
 * the whole object is dead code and the bundler drops every import inside it
 * -- those chunks are never built, never deployed, and cannot be fetched by
 * guessing a name. Listed unconditionally, the code would still ship and
 * only the link to it would be missing.
 */
const ROUTES: Record<string, Loader> = UNLOCKED
  ? {
      "/": WAITLIST,
      /*
       * The market list carries the wallet too.
       *
       * It is the site's front door and the bar on it offers to connect, so
       * the provider has to be above it. The cost is that this page now
       * loads the adapters where the other marketing pages still do not --
       * worth it here, and not on a page whose only action is a link.
       */
      "/markets": async () => {
        const [{ default: Page }, { WalletRoot }] = await Promise.all([
          import("./site/Markets"),
          import("./lib/wallet"),
        ]);
        return { default: () => <WalletRoot><Page /></WalletRoot> };
      },
      // The vault takes deposits, so it signs, so it carries the wallet.
      "/earn": async () => {
        const [{ default: Page }, { WalletRoot }] = await Promise.all([
          import("./site/Earn"),
          import("./lib/wallet"),
        ]);
        return { default: () => <WalletRoot><Page /></WalletRoot> };
      },
      "/list": async () => {
        const [{ default: Page }, { WalletRoot }] = await Promise.all([
          import("./site/List"),
          import("./lib/wallet"),
        ]);
        return { default: () => <WalletRoot><Page /></WalletRoot> };
      },
      "/rewards": async () => {
        const [{ default: Page }, { WalletRoot }] = await Promise.all([
          import("./site/Rewards"),
          import("./lib/wallet"),
        ]);
        return { default: () => <WalletRoot><Page /></WalletRoot> };
      },
      // Cancels orders, so it signs, so it carries the wallet.
      "/portfolio": async () => {
        const [{ default: Page }, { WalletRoot }] = await Promise.all([
          import("./site/Portfolio"),
          import("./lib/wallet"),
        ]);
        return { default: () => <WalletRoot><Page /></WalletRoot> };
      },
      "/trade": async () => {
        const [{ default: App }, { WalletRoot }] = await Promise.all([
          import("./App"),
          import("./lib/wallet"),
        ]);
        return { default: () => <WalletRoot><App /></WalletRoot> };
      },
    }
  : { "/": WAITLIST };

/// A trailing slash is the same page, and `/waitlist` is where the front page
/// used to live -- the X flow still comes back to it carrying its result in
/// the query, so it keeps working and lands on `/`.
const normalize = (p: string) => {
  const path = p.replace(/(.)\/$/, "$1");
  return path === "/waitlist" ? "/" : path;
};

/// Unlocked, a path nobody claimed is a "nothing here" page. It used to open
/// the trade app, which read as the site ignoring the address you typed.
const NOT_FOUND: Loader = () => import("./site/NotFound");

/// Locked, anything that is not the waitlist becomes the waitlist (the
/// middleware has already redirected it home). Unlocked, an unknown path is
/// the not-found page.
const routeFor = (path: string) =>
  ROUTES[path] ?? (UNLOCKED ? NOT_FOUND : ROUTES["/"]);

/*
 * One `lazy` per path, kept.
 *
 * This is the whole reason a second visit is instant: `lazy` caches the
 * resolved module on the component it returns, so going back to a page
 * already seen renders it in the same commit, with no fallback and no
 * network. Building a fresh `lazy` on each render would re-suspend every
 * time and undo the point of the exercise.
 */
const built = new Map<string, ComponentType>();
const pageFor = (path: string) => {
  const hit = built.get(path);
  if (hit) return hit;
  // The waitlist is already in the bundle, so it is rendered as itself. Behind
  // `lazy` it would suspend for a tick, and React holds a revealed Suspense
  // boundary back by up to 300ms -- which was most of the time to first paint.
  if (routeFor(path) === WAITLIST) { built.set(path, WaitlistPage); return WaitlistPage; }
  const made = lazy(routeFor(path));
  built.set(path, made);
  return made;
};

/// Start the chunk before the click. A pointer resting on a link is the
/// earliest honest signal of intent there is, and on a fast connection the
/// module is usually parsed by the time the press lands.
const warm = (path: string) => { if (ROUTES[path]) void routeFor(path)(); };

function Site() {
  const [url, setUrl] = useState(() => location.pathname + location.search);
  const path = normalize(new URL(url, location.origin).pathname);

  // A referral link can open any page, so every page keeps its code.
  useEffect(() => rememberRef(), [url]);

  useEffect(() => {
    const sync = () => setUrl(location.pathname + location.search);

    /*
     * Every link the table knows becomes a swap; everything else is left to
     * the browser. The bail-outs are the contract: a modified click is a new
     * tab, a download is a download, another origin is a real navigation, and
     * a handler that already called preventDefault has said it owns this.
     */
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a");
      if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
      const href = a.getAttribute("href");
      if (!href || href.startsWith("#")) return;
      const to = new URL(href, location.href);
      if (to.origin !== location.origin || to.hash) return;
      if (!ROUTES[normalize(to.pathname)]) return;
      e.preventDefault();
      if (to.href === location.href) return;
      history.pushState(null, "", to.href);
      sync();
    };

    const onOver = (e: Event) => {
      const a = (e.target as Element | null)?.closest?.("a[href]");
      if (!a) return;
      const to = new URL(a.getAttribute("href")!, location.href);
      if (to.origin === location.origin) warm(normalize(to.pathname));
    };

    addEventListener("popstate", sync);
    document.addEventListener("click", onClick);
    // Capture, because `pointerenter` does not bubble.
    document.addEventListener("pointerenter", onOver, true);
    return () => {
      removeEventListener("popstate", sync);
      document.removeEventListener("click", onClick);
      document.removeEventListener("pointerenter", onOver, true);
    };
  }, []);

  // A new page starts at its top. The browser does this for a document load
  // and cannot know to do it for a swap.
  useEffect(() => { window.scrollTo(0, 0); }, [path]);

  const Page = pageFor(path);
  /*
   * Keyed by the full URL, so a link to another market remounts the app
   * rather than leaving it showing the one it was already on: the pages read
   * their query once, at mount, which is the simplest thing that can work
   * and stays correct as long as a changed query means a changed page.
   */
  return <Page key={url} />;
}

// The `/waitlist` alias and, while locked, anything that is not the front
// page, are corrected in the address bar before the first render.
{
  const path = location.pathname.replace(/(.)\/$/, "$1");
  const resolved = normalize(path);
  const hidden = !UNLOCKED && !ROUTES[resolved];
  if (hidden || resolved !== path) {
    history.replaceState(null, "",
      hidden ? "/" : `${resolved}${location.search}${location.hash}`);
  }
}

createRoot(document.getElementById("root")!).render(
  // No fallback: the chunks are small and the page's own background is already
  // painted, so a spinner would only flash.
  <StrictMode>
    <Suspense fallback={null}><Site /></Suspense>
    {/* Paths only: the X sign-in comes back with its result in the query. */}
    <Analytics beforeSend={(e) => ({ ...e, url: e.url.split("?")[0] })} />
  </StrictMode>
);
