/*
 * The wallet picker, in place of the adapter's own modal.
 *
 * It answers through the adapter's `WalletModalContext`, so every
 * `useWalletModal().setVisible(true)` on the site opens this one without
 * knowing it changed. Installed wallets first, then ones that load on
 * demand, then ones this browser does not have, which link out to install.
 * Choosing one selects it; the provider's autoConnect does the connecting,
 * as it did behind the old modal.
 */
import { useMemo, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { useWallet, type Wallet } from "@solana/wallet-adapter-react";
import { WalletReadyState } from "@solana/wallet-adapter-base";
import { WalletModalContext } from "@solana/wallet-adapter-react-ui";
import { useModalFocus } from "@/lib/hooks/use-modal-focus";

/// Shown when the browser exposes no Solana wallet at all.
const SUGGESTED = [
  { name: "Phantom", href: "https://phantom.com/download" },
  { name: "Solflare", href: "https://solflare.com/download" },
  { name: "Backpack", href: "https://backpack.app/downloads" },
];

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

const ROW = "flex h-12 w-full items-center gap-3 rounded-[8px] px-3 text-left text-[14.5px] " +
  "transition-colors hover:bg-panel2 focus-visible:bg-panel2";

function WalletPicker({ onClose }: { onClose: () => void }) {
  const { wallets, wallet: current, select, connect } = useWallet();
  const dialog = useRef<HTMLDivElement>(null);
  useModalFocus(dialog, true, onClose);

  const [ready, missing] = useMemo(() => {
    const rank = (w: Wallet) => (w.readyState === WalletReadyState.Installed ? 0 : 1);
    const usable = wallets
      .filter((w) => w.readyState === WalletReadyState.Installed || w.readyState === WalletReadyState.Loadable)
      .sort((a, b) => rank(a) - rank(b));
    return [usable, wallets.filter((w) => w.readyState === WalletReadyState.NotDetected)];
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
        className="pane-scroll relative max-h-[85dvh] w-full overflow-y-auto rounded-t-[12px] border
                   border-line bg-panel sm:max-w-[400px] sm:rounded-[12px]">
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
          <h2 id="wallet-picker-title" className="text-[16px] font-medium">Connect a wallet</h2>
          <button type="button" onClick={onClose} aria-label="Close"
            className="grid size-8 place-items-center rounded-[8px] text-muted-foreground
                       transition-colors hover:bg-panel2 hover:text-foreground">
            <X size={16} />
          </button>
        </div>

        <div className="p-2">
          {ready.map((w) => (
            <button key={w.adapter.name} type="button" onClick={() => pick(w)} className={ROW}>
              <img src={w.adapter.icon} alt="" className="size-7 flex-none rounded-[6px]" />
              <span className="min-w-0 flex-1 truncate font-medium">{w.adapter.name}</span>
              {w.readyState === WalletReadyState.Installed && (
                <span className="text-[12.5px] text-muted-foreground">Installed</span>
              )}
            </button>
          ))}

          {missing.length > 0 && (
            <>
              {ready.length > 0 && <div className="mx-3 my-2 border-t border-line" />}
              {missing.map((w) => (
                <a key={w.adapter.name} href={w.adapter.url} target="_blank" rel="noreferrer"
                  className={`${ROW} text-muted-foreground hover:text-foreground`}>
                  <img src={w.adapter.icon} alt="" className="size-7 flex-none rounded-[6px] opacity-70" />
                  <span className="min-w-0 flex-1 truncate">{w.adapter.name}</span>
                  <span className="text-[12.5px]">Not installed</span>
                </a>
              ))}
            </>
          )}

          {!ready.length && !missing.length && (
            <div className="px-3 pb-2 pt-3">
              <p className="text-pretty text-[13.5px] leading-[1.55] text-muted-foreground">
                No Solana wallet found in this browser. Install one, then reload this page.
              </p>
              <div className="mt-3 flex flex-col">
                {SUGGESTED.map((s) => (
                  <a key={s.name} href={s.href} target="_blank" rel="noreferrer"
                    className={`${ROW} justify-between`}>
                    <span className="font-medium">{s.name}</span>
                    <span className="text-[12.5px] text-muted-foreground">Install</span>
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>

        <p className="border-t border-line px-5 py-3.5 text-[12.5px] leading-[1.5] text-muted-foreground">
          Connecting signs nothing and moves nothing.
        </p>
      </div>
    </div>
  );
}
