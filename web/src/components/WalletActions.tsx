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
import { Wallet } from "lucide-react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { AddressDisplay } from "@/components/ui/address-display";

export function WalletActions() {
  const { publicKey, disconnect, connecting } = useWallet();
  const { setVisible } = useWalletModal();
  const address = publicKey?.toBase58() ?? null;

  if (address) {
    return (
      /*
       * The address and the disconnect are two controls, not one. Clicking
       * your own address used to disconnect you, which is the wrong thing to
       * put under the most inviting target in the bar -- an address is
       * something you reach for to copy or to look up.
       */
      <div className="flex h-[44px] items-center gap-1 rounded-full border border-line pl-4 pr-2">
        <span className="size-1.5 flex-none rounded-full bg-up" />
        <AddressDisplay address={address} truncateChars={[4, 4]} copyable
          explorerUrl="https://solscan.io/account"
          className="text-[14px] font-medium" />
        <button onClick={() => disconnect()} title="Disconnect"
          aria-label="Disconnect wallet"
          className="rounded px-1.5 py-1 text-[12.5px] text-muted-foreground
                     transition-colors hover:text-down">
          &times;
        </button>
      </div>
    );
  }

  return (
    <>
      <button onClick={() => setVisible(true)} disabled={connecting}
        className="press flex h-[44px] flex-none items-center gap-2 whitespace-nowrap rounded-[12px]
                   bg-panel3 px-4 text-[14.5px] font-medium text-foreground
                   transition-colors hover:bg-line disabled:opacity-50">
        <Wallet size={17} strokeWidth={1.8} aria-hidden />
        {connecting ? "Connecting…" : "Connect"}
      </button>
    </>
  );
}
