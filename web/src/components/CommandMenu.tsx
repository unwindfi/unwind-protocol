// Adapted from sales-crm by Kargul Studio (MIT), components/companies/command-menu/command-menu.tsx; see THIRD_PARTY_NOTICES.md.
/*
 * The one search behind Cmd K, on every app page.
 *
 * Markets by symbol or name, then the site's pages. The trade terminal mounts
 * its own copy fed its own list, so picking a market there switches the
 * terminal in place instead of reloading it; everywhere else a market opens
 * its trade page. Either way it is one component, one shortcut, one look.
 */
import { useEffect, useRef, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import {
  Command, CommandDialog, CommandEmpty, CommandFooter, CommandGroup,
  CommandInput, CommandItem, CommandList, CommandSeparator, Kbd,
} from "@/components/ui/command";
import { TickerLogo } from "@/components/TickerLogo";
import { NavIcon } from "@/components/NavIcon";
import { getMarkets, type Market } from "@/lib/api";
import { pct, price, tone } from "@/lib/format";
import { tradeHref } from "@/lib/urls";
import { DOCS } from "@/site/Chrome";
import { OPEN_COMMAND_MENU as OPEN, isMac } from "@/lib/command-menu";

const PAGES = [
  { label: "Markets", href: "/markets", icon: "markets" },
  { label: "Trade", href: "/trade", icon: "trade" },
  { label: "Earn", href: "/earn", icon: "earn" },
  { label: "List a market", href: "/list", icon: "list" },
  { label: "Rewards", href: "/rewards", icon: "rewards" },
  { label: "Portfolio", href: "/portfolio", icon: "portfolio" },
];


/*
 * Moves the page the way a link would. The site's router (main.tsx) swaps
 * pages on a click on any link it knows, so a click on a detached link takes
 * the same path as one in the nav, without this file importing the router.
 */
function go(href: string, external = false) {
  const a = document.createElement("a");
  a.href = href;
  if (external) { a.target = "_blank"; a.rel = "noreferrer"; }
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function CommandMenu({
  markets: given, open: controlled, onOpenChange, onMarket,
}: {
  /// The list to search. Left out, the menu reads it itself each time it opens.
  markets?: Market[];
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /// Picks a market without leaving the page. Left out, a market opens its
  /// trade page.
  onMarket?: (symbol: string) => void;
}) {
  const [own, setOwn] = useState(false);
  const open = controlled ?? own;
  const setOpen = (v: boolean) => { if (controlled === undefined) setOwn(v); onOpenChange?.(v); };
  const setOpenRef = useRef(setOpen);
  setOpenRef.current = setOpen;
  const openRef = useRef(open);
  openRef.current = open;

  const [query, setQuery] = useState("");
  const [fetched, setFetched] = useState<Market[] | null>(null);
  const ran = useRef(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "k" || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      e.preventDefault();
      setOpenRef.current(!openRef.current);
    };
    const onOpen = () => setOpenRef.current(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN, onOpen);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener(OPEN, onOpen); };
  }, []);

  // A page with no market list of its own reads one when the menu opens, and
  // again on each opening, so prices are never older than the last look.
  useEffect(() => {
    if (!open || given) return;
    let live = true;
    getMarkets().then((ms) => { if (live) setFetched(ms); }).catch(() => {});
    return () => { live = false; };
  }, [open, given]);

  const list = (given ?? fetched ?? [])
    .filter((m) => !m.hidden)
    .sort((a, b) => b.volume24h - a.volume24h || b.oi - a.oi);

  const run = (action: () => void) => {
    ran.current = true;
    setOpen(false);
    action();
  };

  return (
    <CommandDialog open={open} onOpenChange={setOpen}
      title="Search" description="Search markets by symbol or name, or jump to a page"
      onCloseAutoFocus={(e) => {
        // After a jump, focus belongs to the new page, not the old trigger.
        if (ran.current) e.preventDefault();
        ran.current = false;
        setQuery("");
      }}>
      <Command>
        <CommandInput value={query} onValueChange={setQuery}
          placeholder="Search markets and pages" trailing={<Kbd>Esc</Kbd>} />
        <CommandList>
          <CommandEmpty>No results for "{query}"</CommandEmpty>
          {list.length > 0 && (
            <CommandGroup heading="Markets">
              {list.map((m) => (
                <CommandItem key={m.symbol} value={m.symbol} keywords={[m.symbol, m.name]}
                  onSelect={() => run(() => (onMarket ? onMarket(m.symbol) : go(tradeHref(m.symbol))))}>
                  <TickerLogo m={m} size={24} />
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium text-foreground">{m.symbol}</span>
                    <span className="ml-2 text-muted-foreground">{m.name}</span>
                  </span>
                  <span className="n flex-none text-[13px] text-foreground">{price(m.price)}</span>
                  <span className={`n hidden w-16 flex-none text-right text-[13px] sm:block ${tone(m.changePct)}`}>
                    {pct(m.changePct)}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {list.length > 0 && <CommandSeparator />}
          {/* Values carry nothing but the thing searched for (a symbol, a
              path), since cmdk scores the value too: a shared prefix like
              "market " let any query with an "e" in it match every row. */}
          <CommandGroup heading="Pages">
            {PAGES.map((p) => (
              <CommandItem key={p.href} value={p.href} keywords={[p.label]}
                onSelect={() => run(() => go(p.href === "/trade" ? tradeHref() : p.href))}>
                <NavIcon name={p.icon} size={16} />
                <span className="flex-1">{p.label}</span>
              </CommandItem>
            ))}
            <CommandItem value="docs" keywords={["Docs", "Documentation"]}
              onSelect={() => run(() => go(DOCS, true))}>
              <ArrowUpRight size={16} strokeWidth={1.75} aria-hidden />
              <span className="flex-1">Docs</span>
            </CommandItem>
          </CommandGroup>
        </CommandList>
        <CommandFooter className="max-sm:hidden">
          <span className="flex items-center gap-1.5"><Kbd>↑</Kbd><Kbd>↓</Kbd>Move</span>
          <span className="flex items-center gap-1.5"><Kbd>↵</Kbd>Open</span>
          <span className="ml-auto flex items-center gap-1.5"><Kbd>{isMac ? "⌘K" : "Ctrl K"}</Kbd>Toggle</span>
        </CommandFooter>
      </Command>
    </CommandDialog>
  );
}

export default CommandMenu;
