import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Mark } from "./Brand";
import { ThemeToggle } from "@/components/ThemeToggle";
import { AddressDisplay } from "@/components/ui/address-display";
import { PageMenu } from "@/site/Chrome";

export function Nav() {
  const { publicKey, disconnect, connecting } = useWallet();
  const { setVisible } = useWalletModal();
  const address = publicKey?.toBase58() ?? null;
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
        <Mark size={25} />
        <span className="text-[16px] font-semibold tracking-[.005em]">unwind</span>
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
        {address ? (
          /*
           * The address and the disconnect are two controls now, not one.
           *
           * Clicking your own address used to disconnect you, which is the
           * wrong thing to put under the most inviting target in the bar --
           * an address is something you reach for to copy or to look up, and
           * Oxygen's display gives it both without inventing either.
           */
          <div className="flex min-h-[34px] items-center gap-1 rounded-md border border-line
                          bg-panel2 pl-2.5 pr-1 md:min-h-0">
            <span className="size-1.5 flex-none rounded-full bg-up" />
            <AddressDisplay address={address} truncateChars={[4, 4]} copyable
              explorerUrl="https://solscan.io/account"
              className="text-[12.5px] font-medium" />
            <button onClick={() => disconnect()} title="Disconnect"
              aria-label="Disconnect wallet"
              className="rounded px-1.5 py-1 text-[12.5px] text-muted-foreground
                         transition-colors hover:text-down">
              &times;
            </button>
          </div>
        ) : (
          <>
            <button onClick={() => setVisible(true)} disabled={connecting}
              className="press flex h-9 items-center rounded-full bg-foreground px-4 text-[13px]
                         font-medium text-background transition-opacity hover:opacity-90
                         disabled:opacity-50">
              {connecting ? "Connecting…" : "Connect"}
            </button>
          </>
        )}
        <PageMenu here="/trade" className="-mr-1 md:hidden" />
      </div>
    </nav>
  );
}
