import { Wordmark } from "@/components/Wordmark";
import { GlassMark } from "@/components/GlassMark";
import { ThemeToggle } from "@/components/ThemeToggle";
import { WalletActions } from "@/components/WalletActions";
import { PageMenu } from "@/site/Chrome";

export function Nav() {
  // Where a section has a real page, the nav item goes there; one without
  // stays inert rather than pointing at a 404.
  const links: { label: string; href?: string }[] = [
    { label: "Trade", href: "/trade" },
    { label: "Earn", href: "/earn" },
    { label: "Portfolio", href: "/portfolio" },
    { label: "Markets", href: "/markets" },
    { label: "Docs", href: "https://unwind.gitbook.io/unwind-docs" },
  ];
  return (
    // `safe-t` keeps the bar clear of the notch when the page is installed to a
    // home screen and runs without browser chrome.
    <nav className="relative flex h-[46px] flex-none items-center gap-1 border-b border-line
                    bg-panel px-3 safe-t md:h-[42px]">
      <a href="/" className="flex items-center gap-2 md:mr-5" aria-label="unwind home">
        <GlassMark className="h-[25px] w-[25px]" />
        <Wordmark height={17} />
      </a>
      {/* The section links are a desktop affordance. On a phone the bottom tab
          bar moves around this market, and the menu at the end of the bar
          reaches every other page. */}
      {links.map((l, i) => {
        const cls = `hidden rounded-md px-3 py-[7px] text-[12.5px] font-medium transition-colors
          md:block ${i === 0 ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`;
        return l.href
          ? <a key={l.label} href={l.href} className={cls}
              {...(l.href.startsWith("http") ? { target: "_blank", rel: "noreferrer" } : {})}>{l.label}</a>
          : <button key={l.label} className={cls}>{l.label}</button>;
      })}
      <div className="ml-auto flex items-center gap-2">
        <ThemeToggle className="h-[34px] w-[34px] rounded-md md:h-[30px] md:w-[30px]" />
        {/* The same wallet control the site's header uses, so the phone's
            trade bar never shows a second design of it. */}
        <WalletActions />
        <PageMenu here="/trade" className="-mr-1 md:hidden" />
      </div>
    </nav>
  );
}
