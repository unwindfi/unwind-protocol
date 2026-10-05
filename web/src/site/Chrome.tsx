import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import "@/site/serif.css";
import {
  ArrowUpRight, Menu, Search, X,
} from "lucide-react";
import { ThemeToggle } from "@/components/ThemeToggle";
import { NavIcon } from "@/components/NavIcon";
import { useHasBackend } from "@/lib/api";

export const REPO = "https://github.com/prarimz/unwind";

/// The two button looks, after the /list card: an inverted pill for the one
/// thing a page wants you to do, and an outlined pill for everything else.
export const SOLID =
  "press inline-flex h-11 items-center justify-center rounded-full bg-foreground px-7 text-[15px] " +
  "font-medium text-background transition-opacity hover:opacity-85";
export const OUTLINE =
  "press inline-flex h-11 items-center justify-center rounded-full bg-panel2 px-6 " +
  "text-[15px] font-medium transition-colors hover:bg-panel3";

/// beUI's pill tabs in the house look: no track, and the sliding indicator
/// is the same inverted pill as the buttons, with its label flipped to match.
export const PILL_LIST = "rounded-full bg-panel2 p-1 gap-0.5";
export const PILL_TRIGGER =
  "h-9 px-4 text-[14px] font-normal text-muted-foreground [&_[data-tabs-label]]:font-medium " +
  "[&_[data-tabs-label]]:text-foreground";
export const PILL_INDICATOR = "bg-panel3";

// `main` marks the page's own content, so a screen reader can jump past the header.
export const Shell = ({ children, className = "", main = false }: {
  children: ReactNode; className?: string; main?: boolean;
}) => {
  const Tag = main ? "main" : "div";
  return <Tag className={`mx-auto w-full max-w-[1180px] px-5 sm:px-6 ${className}`}>{children}</Tag>;
};

export const DOCS = "https://unwind.gitbook.io/unwind-docs";

export const X_URL = "https://x.com/unwindfi";

/*
 * Sections on the left, actions on the right.
 *
 * Opening a market is not in the bar: /markets offers it in its hero ("Or
 * open one") and the list has its own page, so the bar keeps to sections
 * and the wallet.
 */
/// Each link carries a small lucide icon beside its label, after the
/// panelled nav the user shared as the reference (2026-09-26).
const NAV = [
  { label: "Markets", href: "/markets", icon: "markets" },
  { label: "Trade", href: "/trade", icon: "trade" },
  { label: "Earn", href: "/earn", icon: "earn" },
  { label: "Portfolio", href: "/portfolio", icon: "portfolio" },
  { label: "Rewards", href: "/rewards", icon: "rewards" },
  { label: "List", href: "/list", icon: "list" },
] as { label: string; href: string; icon: string; out?: boolean }[];

/*
 * One header and one footer for every page on the site.
 *
 * These are plain `href`s, and they stay plain: the router in `main.tsx`
 * catches the click on its way up and swaps the page, so the same markup
 * works whether or not it is mounted under one -- and middle-click, open in
 * new tab and copy link address keep meaning what they say. `here` is passed
 * rather than read from location so a page cannot disagree with the nav about
 * which page it is.
 */
export function SiteHeader({ here, tradeHref = "/trade", actions }: {
  here?: string;
  /// Carries the market the visitor was looking at into the app.
  tradeHref?: string;
  /*
   * What goes in the right-hand panel instead of the site's two calls to
   * action.
   *
   * The trading screen used to carry a header of its own -- a different
   * height, a different mark, a different set of links -- so moving between
   * the site and the app redrew the top of the window and made one product
   * feel like two. It is the same bar everywhere now; only the last panel
   * changes, because a wallet is the one control the site has no use for.
   */
  actions?: ReactNode;
}) {
  return (
    /*
     * The bar is a row of cells rather than a strip with things floating in
     * it: the mark sits in its own bordered box, the links in theirs, and the
     * actions in a third at the far end. It is what makes a header this
     * sparse still read as built rather than as a gap above the page.
     */
    /*
     * The bar is three panels with gaps between them, not one strip divided
     * by lines.
     *
     * A panel has a border all the way round and a corner radius, so the bar
     * reads as built out of parts rather than ruled into sections -- and the
     * empty middle becomes a deliberate piece of the composition instead of
     * the space left over between two ends.
     *
     * The mark shares the first panel with the links. Giving it one of its
     * own put a divider between a logo and the navigation beside it, which
     * is a seam with nothing on either side of it.
     */
    // Above everything a page lays over its hero (the search on /markets sits
    // at z-30), so the phone menu that opens under the bar is never cut.
    /*
     * The bar the prediction-market terminals use: the mark and a search
     * field on the left, the wallet on the right, and under it one row of
     * the site's parts as words with their icons, the current one in full
     * ink. No panels, no rules: the page's pale ground is the frame.
     */
    <header className="relative z-50 bg-background safe-t">
      <div className="flex h-[64px] items-center gap-4 px-4 sm:px-6">
        <a href="/markets" aria-label="unwind" className="flex flex-none items-center gap-2.5">
          <img src="/waitlist/logo-glass-mark.webp" alt="" className="h-8 w-8" />
          <span className="text-[17px] font-semibold tracking-[-.02em]">unwind</span>
        </a>
        {/* Not on /markets, whose own search is the page's hero: two search
            fields on one screen asked which one to use. */}
        {here !== "/markets" && <a href="/markets" aria-label="Search markets"
          className="hidden h-10 w-[300px] items-center gap-2.5 rounded-full bg-panel px-4 text-[14px]
                     text-muted-foreground transition-colors hover:bg-panel2 md:flex lg:w-[340px]">
          <Search size={16} strokeWidth={2} aria-hidden />
          Search markets
        </a>}
        <div className="ml-auto flex flex-none items-center gap-2">
          {actions}
          <ThemeToggle className="h-10 w-10" />
          <PageMenu here={here} tradeHref={tradeHref} className="lg:hidden" />
        </div>
      </div>
      <nav className="strip-scroll hidden items-center gap-1 px-4 pb-3 sm:px-6 lg:flex" aria-label="Pages">
        {NAV.filter((l) => l.href !== "/list").map((l) => (
          <Fragment key={l.href}>
          <a href={l.href === "/trade" ? tradeHref : l.href}
            {...(l.out ? { target: "_blank", rel: "noreferrer" } : {})}
            aria-current={here === l.href ? "page" : undefined}
            className={`flex h-9 flex-none items-center gap-2 rounded-full px-3 text-[14.5px]
                        transition-colors ${l.href === "/list"
              /* The one thing anyone can add to the venue, set apart by a
                 rule and in full ink. */
              ? "font-medium text-foreground hover:opacity-80"
              : here === l.href
                ? "font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground"}`}>
            <NavIcon name={l.icon} size={18} />
            {l.label}
          </a>
          </Fragment>
        ))}
        {/* List sits on the right, under the wallet: the venue's other way
            in, apart from the pages you browse. */}
        <span className="ml-auto flex items-center gap-3">
          {here !== "/list" && (
          <a href="/list" 
            className="flex h-9 flex-none items-center gap-2 rounded-full px-3 text-[14.5px] font-medium
                       text-foreground hover:opacity-80">
            <NavIcon name="list" size={18} />
            List
          </a>
          )}
        </span>
      </nav>
    </header>
  );
}

/*
 * Every page, behind one button, for screens too narrow for the links.
 *
 * The bar's links used to scroll sideways inside it, which on a phone showed
 * "Markets" and half of "Trade" and gave no sign the rest existed. This opens
 * them all as full-width rows under whichever bar it sits in (the nearest
 * positioned ancestor), and closes on a choice, a tap outside or Escape.
 * Shared by the site header and the trade app's phone bar.
 */
export function PageMenu({ here, tradeHref = "/trade", className = "" }: {
  here?: string; tradeHref?: string; className?: string;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const out = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", out);
    window.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", out); window.removeEventListener("keydown", key); };
  }, [open]);
  return (
    <div ref={box} className={className}>
      <button type="button" onClick={() => setOpen((o) => !o)}
        aria-label={open ? "Close menu" : "Open menu"} aria-expanded={open}
        className="press grid h-[40px] w-[40px] flex-none place-items-center rounded-full
                   text-muted-foreground transition-colors hover:text-foreground">
        {open ? <X size={20} strokeWidth={1.8} /> : <Menu size={20} strokeWidth={1.8} />}
      </button>
      {open && (
        <nav aria-label="Pages"
          className="absolute inset-x-2 top-full z-40 mt-2 grid gap-1 rounded-[14px] border border-line
                     bg-panel p-2 shadow-[0_18px_40px_-12px_rgba(0,0,0,.55)]">
          {NAV.map((l) => (
            <a key={l.href} href={l.href === "/trade" ? tradeHref : l.href}
              {...(l.out ? { target: "_blank", rel: "noreferrer" } : {})}
              aria-current={here === l.href ? "page" : undefined}
              onClick={() => setOpen(false)}
              className={`flex h-[52px] items-center gap-3 rounded-[10px] px-4 text-[16px] transition-colors ${
                here === l.href ? "bg-panel2 font-medium text-foreground"
                  : "text-muted-foreground hover:bg-panel2 hover:text-foreground"}`}>
              <NavIcon name={l.icon} size={20} />
              {l.label}
              {l.out && <ArrowUpRight size={15} strokeWidth={1.8} aria-hidden className="ml-auto" />}
            </a>
          ))}
        </nav>
      )}
    </div>
  );
}

export function SiteFooter(_: { tradeHref?: string } = {}) {
  const left = [
    { label: "Markets", href: "/markets" },
    { label: "Earn", href: "/earn" },
    { label: "List a market", href: "/list" },
  ];
  const right = [
    { label: "Documentation", href: DOCS, out: true },
    { label: "Risk Hub", href: "/risk" },
    { label: "Rewards", href: "/rewards" },
  ];
  const A = ({ l }: { l: { label: string; href: string; out?: boolean } }) => (
    <a href={l.href} {...(l.out ? { target: "_blank", rel: "noreferrer" } : {})}
      className="text-[13.5px] text-muted-foreground hover:text-foreground">{l.label}</a>
  );
  return (
    /*
     * One card at the foot of the page: where to follow on the left, two
     * short columns of links on the right, and the name set huge across the
     * bottom, cropped by the card, with a violet light rising behind it.
     */
    <footer className="mt-auto px-3 pb-3 safe-b sm:px-5 sm:pb-5">
      <div className="relative isolate overflow-hidden rounded-[20px] border border-line bg-panel">
        <div aria-hidden className="pointer-events-none absolute inset-0 -z-10
          bg-[radial-gradient(70%_80%_at_85%_105%,rgba(106,77,244,.35),transparent_70%)]" />
        <div className="grid gap-10 px-7 pt-10 sm:px-12 sm:pt-14 md:grid-cols-[1fr_auto]">
          <div>
            <p className="text-[20px] font-medium tracking-[-.01em]">Join the community</p>
            <div className="mt-5 flex flex-col gap-3 text-[13.5px] text-muted-foreground">
              <a href={X_URL} target="_blank" rel="noreferrer" className="flex items-center gap-2.5 hover:text-foreground">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                </svg>
                Follow on X
              </a>
            </div>
          </div>
          <nav aria-label="Footer" className="grid grid-cols-2 gap-x-20 gap-y-3.5 md:text-right">
            <div className="flex flex-col gap-3.5">{left.map((l) => <A key={l.label} l={l} />)}</div>
            <div className="flex flex-col gap-3.5">{right.map((l) => <A key={l.label} l={l} />)}</div>
          </nav>
        </div>
        {/*
         * The lockup across the foot, cropped by the card: the mark as a solid
         * grey silhouette, then the name. Big
         * enough that the card's edge cuts both.
         */}
        <div aria-hidden className="relative mt-12 flex select-none items-end gap-[.03em] whitespace-nowrap px-5
                                    font-medium leading-[.8] tracking-[-.06em] text-foreground/30 sm:px-10"
          style={{ fontSize: "clamp(72px, 22vw, 360px)" }}>
          <span className="relative mb-[-.3em] mr-[.02em] h-[.95em] w-[.95em] flex-none">
            <span className="absolute inset-0 bg-current"
              style={{ WebkitMaskImage: "url(/waitlist/logo-glass-mark.webp)", maskImage: "url(/waitlist/logo-glass-mark.webp)",
                       WebkitMaskSize: "contain", maskSize: "contain", WebkitMaskRepeat: "no-repeat", maskRepeat: "no-repeat",
                       WebkitMaskPosition: "center", maskPosition: "center" }} />
          </span>
          <span className="-mb-[.2em]">unwind</span>
        </div>
      </div>
    </footer>
  );
}


/// The masthead every page below the landing page opens with.
export function PageHead({ label, title, lede }: {
  label: string; title: ReactNode; lede: ReactNode;
}) {
  return (
    <section className="border-b border-line">
      <Shell className="py-11 md:py-14">
        <p className="rise text-[12px] font-medium uppercase tracking-[.16em] text-dim"
          style={{ animationDelay: "60ms" }}>
          {label}
        </p>
        <h1 className="rise mt-3.5 max-w-[22ch] text-balance text-[clamp(1.6rem,3vw,2.2rem)]
                       font-semibold leading-[1.12] tracking-[-.02em]"
          style={{ animationDelay: "140ms" }}>
          {title}
        </h1>
        <p className="rise mt-4 max-w-[64ch] text-[14.5px] leading-[1.6] text-muted-foreground"
          style={{ animationDelay: "220ms" }}>
          {lede}
        </p>
      </Shell>
    </section>
  );
}
