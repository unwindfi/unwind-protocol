import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { Wordmark } from "@/components/Wordmark";
import { GlassMark } from "@/components/GlassMark";
import {
  ArrowUpRight, Menu, Search, X,
} from "lucide-react";
import { SiX } from "@icons-pack/react-simple-icons";
import { ThemeToggle } from "@/components/ThemeToggle";
import { NavIcon } from "@/components/NavIcon";
import { isMac, openCommandMenu } from "@/lib/command-menu";


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
  return <Tag id={main ? "main" : undefined} className={`mx-auto w-full max-w-[1180px] px-5 sm:px-6 ${className}`}>{children}</Tag>;
};

/// The first stop for a keyboard: hidden until focused, then past the bar.
export const SkipLink = () => (
  <a href="#main"
    className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-[60]
               focus:rounded-full focus:bg-foreground focus:px-4 focus:py-2 focus:text-[14px]
               focus:font-medium focus:text-background">
    Skip to content
  </a>
);

export const DOCS = "https://docs.unwindfi.xyz";

export const X_URL = "https://x.com/unwindfi";

export const RISKS = `${DOCS}/about-unwind/risks`;
/// The privacy policy, terms and risk disclosures (site/Legal.tsx).
export const LEGAL = [
  { href: "/privacy", label: "Privacy Policy" },
  { href: "/terms", label: "Terms of Service" },
  { href: "/disclosures", label: "Disclosures" },
];

export const SUPERTEAM_NP = "https://np.superteam.fun";

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
      <SkipLink />
      <div className="flex h-[64px] items-center gap-4 px-4 sm:px-6">
        <a href="/markets" aria-label="unwind" className="flex flex-none items-center gap-2.5">
          <GlassMark className="h-8 w-8" />
          {/* At 320px the bar cannot fit the word, the wallet, the theme and
              the menu; the mark alone still says whose page this is. */}
          <Wordmark height={18} className="max-[359px]:hidden" />
        </a>
        {/* Not on /markets, whose own search is the page's hero: two search
            fields on one screen asked which one to use. */}
        {/* Opens the Cmd K menu; the link is what it does without script. */}
        {here !== "/markets" && <a href="/markets" aria-label="Search markets"
          onClick={(e) => { e.preventDefault(); openCommandMenu(); }}
          className="hidden h-10 w-[300px] items-center gap-2.5 rounded-full bg-panel px-4 text-[14px]
                     text-muted-foreground transition-colors hover:bg-panel2 md:flex lg:w-[340px]">
          <Search size={16} strokeWidth={2} aria-hidden />
          Search markets
          <kbd className="ml-auto font-sans text-[12px] text-dim">{isMac ? "⌘K" : "Ctrl K"}</kbd>
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
  type L = { label: string; href: string; out?: boolean; Icon?: typeof SiX; logo?: boolean };
  const cols: { title: string; links: L[] }[] = [
    { title: "Product", links: [
      { label: "Markets", href: "/markets" },
      { label: "Earn", href: "/earn" },
      { label: "List a market", href: "/list" },
      { label: "Rewards", href: "/rewards" },
    ] },
    { title: "Resources", links: [
      { label: "Documentation", href: DOCS, out: true },
      { label: "Risks", href: RISKS, out: true },
    ] },
    // Brand marks come from simple-icons; lucide carries none.
    { title: "Community", links: [
      { label: "X", href: X_URL, out: true, Icon: SiX },
      { label: "Superteam Nepal", href: SUPERTEAM_NP, out: true, logo: true },
    ] },
  ];
  const out = { target: "_blank", rel: "noreferrer" };
  return (
    /*
     * One card at the foot of the page: the lockup and the line on the left,
     * three labelled columns on the right, then a rule over the
     * fine print. The brand marks sit beside their links under Community.
     */
    <footer className="mt-auto px-3 pb-3 safe-b sm:px-5 sm:pb-5">
      <div className="relative isolate overflow-hidden rounded-[20px] border border-line bg-panel px-6 pt-8 pb-16 sm:px-10 sm:pt-10 sm:pb-20">
        {/* The /markets hero's field as a band along the foot, below the text,
            so nothing is ever set on top of it. */}
        <img src="/waitlist/field.webp" alt="" aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-[160px] w-full object-cover opacity-40
                     [mask-image:linear-gradient(to_top,black,rgba(0,0,0,.55)_30%,rgba(0,0,0,.18)_60%,transparent)]
                     dark:opacity-55" />
        <div className="grid gap-8 md:grid-cols-[1.2fr_2fr]">
          <div>
            <a href="/markets" className="flex items-center gap-2.5">
              <GlassMark className="h-7 w-7" />
              <Wordmark height={21} />
            </a>
            <p className="text-pretty mt-3 max-w-[34ch] text-[13.5px] leading-relaxed text-muted-foreground">
              Every market clears by auction. Anyone can open one.
            </p>
          </div>
          <nav aria-label="Footer" className="grid grid-cols-2 gap-8 sm:grid-cols-3">
            {cols.map((c) => (
              <div key={c.title}>
                <p className="text-[14px] font-semibold">{c.title}</p>
                <ul className="mt-3 flex flex-col gap-2">
                  {c.links.map((l) => (
                    <li key={l.label}>
                      <a href={l.href} {...(l.out ? out : {})} aria-label={l.logo ? l.label : undefined}
                        className="inline-flex items-center gap-2 text-[13.5px] text-muted-foreground
                                   transition-colors hover:text-foreground">
                        {l.Icon && <l.Icon size={13} aria-hidden />}
                        {l.logo ? (
                          /* Superteam's own lockup, from np.superteam.fun: white
                             for dark, the wordmark in black for light. Set at
                             the links' height so it sits in the list. */
                          <span className="opacity-75 transition-opacity hover:opacity-100">
                            <img src="/footer/superteam-np-light.webp" alt="" width={568} height={72}
                              className="mt-0.5 h-[15px] w-auto dark:hidden" />
                            <img src="/footer/superteam-np-dark.webp" alt="" width={568} height={72}
                              className="mt-0.5 hidden h-[15px] w-auto dark:block" />
                          </span>
                        ) : l.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        </div>

        <div className="mt-9 flex flex-col gap-5 border-t border-line pt-5 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[12px] leading-relaxed text-muted-foreground">
              <span>&copy; {new Date().getFullYear()} unwind.</span>
              {LEGAL.map((l) => (
                <a key={l.href} href={l.href} className="transition-colors hover:text-foreground">{l.label}</a>
              ))}
            </p>
            <p className="text-pretty mt-2 max-w-[110ch] text-[12px] leading-relaxed text-muted-foreground">
              unwind runs perpetual futures markets on Solana that anyone can open, each cleared by batch
              auction. Every action is a transaction you sign, settled by the unwind program; the program is
              unaudited. Nothing here is investment advice. Perpetuals are leveraged, and a position can be
              liquidated with the loss of its whole margin; smart-contract, oracle, keeper, liquidity and
              listing risks are described in the{" "}
              <a href={DOCS} {...out} className="underline underline-offset-2 hover:text-foreground">documentation</a>.
              A market being listed is not an endorsement. Devnet settles in test USDC against devnet copies of
              tokens marked at Jupiter prices, and carries no real value. Tokenized stocks (xStocks) are not
              available to US persons. unwind is not affiliated with Backed, Jupiter, Pyth or the issuers of
              the assets its markets track.
            </p>
          </div>
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
        <p className="rise text-[12px] font-medium uppercase tracking-[.16em] text-dim">
          {label}
        </p>
        <h1 className="rise mt-3.5 max-w-[22ch] text-balance text-[clamp(1.6rem,3vw,2.2rem)]
                       font-semibold leading-[1.12] tracking-[-.02em]"
          style={{ animationDelay: "40ms" }}>
          {title}
        </h1>
        <p className="text-pretty rise mt-4 max-w-[64ch] text-[14.5px] leading-[1.6] text-muted-foreground"
          style={{ animationDelay: "80ms" }}>
          {lede}
        </p>
      </Shell>
    </section>
  );
}
