/*
 * The wallet, as the last panel of the shared header.
 *
 * This is everything the trading screen's own bar carried that the site's
 * does not: who you are connected as, or the one way to start.
 *
 * There was a "Demo" button beside it that connected nothing. Without a
 * wallet the server already signs on localnet, so the button's whole effect
 * was a toast saying so -- a control whose action is to explain that no
 * action is needed. The behaviour it described is unchanged and still there.
 *
 * The links, the mark and the theme switch beside it are the site's,
 * unchanged, because the whole point of moving these controls here was to
 * stop the app from drawing a second header of its own.
 */
import { NavIcon } from "@/components/NavIcon";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Copy, ExternalLink, LogOut } from "lucide-react";

export function WalletActions() {
  const { publicKey, disconnect, connecting } = useWallet();
  const { setVisible } = useWalletModal();
  const address = publicKey?.toBase58() ?? null;

  if (address) return <Connected address={address} onDisconnect={() => disconnect()} />;
  // In development `?connected` draws the connected tile without a wallet.
  if (import.meta.env.DEV && location.search.includes("connected")) {
    return <Connected address="CGgcR7nQe1xbYm2sQ8kTvW3pLdXh9uFoAa4ZjKtscK" onDisconnect={() => {}} />;
  }

  return (
    <>
      <button onClick={() => setVisible(true)} disabled={connecting}
        className="press flex h-11 flex-none items-center gap-2.5 whitespace-nowrap rounded-[14px]
                   bg-panel3 px-4 text-[15px] text-foreground
                   hover:bg-line disabled:opacity-35">
        <NavIcon name="wallet" size={18} />
        {/* Spelled out where the header has room; a phone header fits one word. */}
        {connecting ? "Connecting…" : (
          <><span className="sm:hidden">Connect</span><span className="hidden sm:inline">Connect wallet</span></>
        )}
      </button>
    </>
  );
}

/*
 * Connected: the same grey tile the connect button is, with the address in the
 * page's own type and a chevron. Copy, Solscan and Disconnect live in a short
 * menu under it rather than as three icons crammed inside the tile.
 */
function Connected({ address, onDisconnect }: { address: string; onDisconnect: () => void }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const out = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", out); window.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", out); window.removeEventListener("keydown", key); };
  }, [open]);
  const short = `${address.slice(0, 4)}…${address.slice(-4)}`;
  const copy = async () => {
    try { await navigator.clipboard.writeText(address); setCopied(true); setTimeout(() => setCopied(false), 1200); } catch { /* denied */ }
  };
  const ITEM = "flex h-10 w-full items-center gap-2.5 rounded-[10px] px-3 text-left text-[14px] text-muted-foreground hover:bg-panel2 hover:text-foreground";
  return (
    <div ref={box} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="menu"
        className={`press flex h-11 items-center gap-2.5 rounded-[14px] px-4 text-[15px] text-foreground ${
          open ? "bg-line" : "bg-panel3 hover:bg-line"}`}>
        <span className="size-2 flex-none rounded-full bg-up" />
        <span className="n">{short}</span>
        <ChevronDown size={15} strokeWidth={2} className={`text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-[calc(100%+6px)] z-50 w-[220px] rounded-[16px] border border-line
                                    bg-panel p-1.5 shadow-[0_18px_40px_-14px_rgba(0,0,0,.5)]">
          <button type="button" role="menuitem" onClick={copy} className={ITEM}>
            {copied ? <Check size={15} /> : <Copy size={15} />}
            {copied ? "Copied" : "Copy address"}
          </button>
          <a role="menuitem" href={`https://solscan.io/account/${address}`} target="_blank" rel="noreferrer" className={ITEM}>
            <ExternalLink size={15} />
            View on Solscan
          </a>
          <button type="button" role="menuitem" onClick={() => { setOpen(false); onDisconnect(); }}
            className={`${ITEM} hover:text-down`}>
            <LogOut size={15} />
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}
