/*
 * The wallet picker, in place of the adapter's own modal.
 *
 * It answers through the adapter's `WalletModalContext`, so every
 * `useWalletModal().setVisible(true)` on the site opens this one without
 * knowing it changed. One rounded list: every Solana wallet this browser
 * has, Phantom and Backpack first, then whichever of those two it lacks, as
 * install links. Choosing one selects it; the provider's autoConnect does the
 * connecting, as it did behind the old modal.
 */
import { useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronRight, X } from "lucide-react";
import { useWallet, type Wallet } from "@solana/wallet-adapter-react";
import { WalletReadyState } from "@solana/wallet-adapter-base";
import { WalletModalContext } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-wallets";
import { useModalFocus } from "@/lib/hooks/use-modal-focus";

/*
 * Offered whether or not this browser has them: the two wallets most Solana
 * traders use. When one is not installed its row links to its download page.
 * Any other wallet shows only when the browser has it. Phantom's mark comes
 * from its adapter; Backpack ships none, so without the extension its row
 * carries its initial on its red.
 */
const phantom = new PhantomWalletAdapter();
const SUGGESTED: { name: string; href: string; icon: string | null; tint: string }[] = [
  { name: "Phantom", href: phantom.url, icon: phantom.icon, tint: "" },
  { name: "Backpack", href: "https://backpack.app/downloads", icon: null, tint: "bg-[#e33e3f]" },
];
const ORDER = SUGGESTED.map((w) => w.name);

export function WalletPickerProvider({ children }: { children: ReactNode }) {
  const [visible, setVisible] = useState(false);
  const value = useMemo(() => ({ visible, setVisible }), [visible]);
  return (
    <WalletModalContext.Provider value={value}>
      {children}
      {visible && <WalletPicker onClose={() => setVisible(false)} />}
    </WalletModalContext.Provider>
  );
}

const ROW = "flex h-14 w-full items-center gap-3 px-3.5 text-left transition-colors " +
  "hover:bg-panel3 focus-visible:bg-panel3";

function Chevron() {
  return (
    <span className="grid size-6 flex-none place-items-center rounded-full bg-panel3 text-muted-foreground">
      <ChevronRight size={14} strokeWidth={2} />
    </span>
  );
}

function WalletPicker({ onClose }: { onClose: () => void }) {
  const { wallets, wallet: current, select, connect } = useWallet();
  const dialog = useRef<HTMLDivElement>(null);
  useModalFocus(dialog, true, onClose);

  // Every Solana wallet this browser exposes, Phantom and Backpack first;
  // then whichever of those two it does not have, as install links.
  const { ready, install } = useMemo(() => {
    const rank = (w: Wallet) => {
      const i = ORDER.indexOf(String(w.adapter.name));
      return i < 0 ? ORDER.length : i;
    };
    const ready = wallets
      .filter((w) => w.readyState === WalletReadyState.Installed || w.readyState === WalletReadyState.Loadable)
      .sort((a, b) => rank(a) - rank(b));
    const have = new Set(ready.map((w) => String(w.adapter.name)));
    return { ready, install: SUGGESTED.filter((s) => !have.has(s.name)) };
  }, [wallets]);

  const pick = (w: Wallet) => {
    onClose();
    // Picking the wallet already selected changes nothing the provider
    // watches, so it would never connect; ask it directly.
    if (current?.adapter.name === w.adapter.name) void connect().catch(() => { /* the wallet says why */ });
    else select(w.adapter.name);
  };

  return (
    <div className="fixed inset-0 z-[95] flex items-end justify-center sm:items-center sm:p-6">
      <button type="button" aria-label="Close" tabIndex={-1} onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/60" />
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="wallet-picker-title"
        className="pane-scroll relative max-h-[85dvh] w-full overflow-y-auto rounded-t-[20px] border
                   border-line bg-panel px-4 pb-5 pt-6 safe-b sm:max-w-[380px] sm:rounded-[20px] sm:px-5">
        <button type="button" onClick={onClose} aria-label="Close"
          className="press absolute right-3 top-3 grid size-9 place-items-center rounded-full
                     text-muted-foreground transition-colors hover:bg-panel2 hover:text-foreground">
          <X size={16} strokeWidth={1.75} />
        </button>

        <h2 id="wallet-picker-title" className="text-center text-[16px] font-medium">Connect wallet</h2>
        <p className="text-pretty mx-auto mt-1 max-w-[280px] text-center text-[13px] leading-[1.5] text-muted-foreground">
          Trade, list and back markets on Solana.
        </p>

        <div className="mt-5 divide-y divide-line overflow-hidden rounded-[16px] bg-panel2">
          {ready.map((w) => (
            <button key={w.adapter.name} type="button" onClick={() => pick(w)} className={ROW}>
              <img src={w.adapter.icon} alt="" className="size-9 flex-none rounded-[9px]" />
              <span className="min-w-0 flex-1 truncate text-[14.5px] font-medium">{w.adapter.name}</span>
              <Chevron />
            </button>
          ))}
          {install.map((s) => (
            <a key={s.name} href={s.href} target="_blank" rel="noreferrer" className={ROW}>
              {s.icon
                ? <img src={s.icon} alt="" className="size-9 flex-none rounded-[9px]" />
                : <span aria-hidden className={`grid size-9 flex-none place-items-center rounded-[9px]
                                                text-[17px] font-semibold text-white ${s.tint}`}>{s.name[0]}</span>}
              <span className="min-w-0 flex-1 truncate text-[14.5px] font-medium">{s.name}</span>
              <span className="text-[12.5px] text-muted-foreground">Install</span>
              <Chevron />
            </a>
          ))}
        </div>

        <p className="text-pretty mt-5 text-center text-[12px] leading-[1.55] text-muted-foreground">
          By connecting, you agree to the{" "}
          <a href="/terms" className="text-foreground hover:underline">Terms of Service</a> and{" "}
          <a href="/privacy" className="text-foreground hover:underline">Privacy Policy</a>.
        </p>
      </div>
    </div>
  );
}
