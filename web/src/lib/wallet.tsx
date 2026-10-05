import { useMemo, type ReactNode } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import "@solana/wallet-adapter-react-ui/styles.css";
import { Welcome } from "@/components/Welcome";

/// The validator this app is served from. A wallet must be pointed at the same
/// cluster, which for a throwaway localnet means adding it as a custom RPC —
/// hence the demo account staying available alongside.
export const RPC_URL = import.meta.env.VITE_RPC_URL ?? "http://127.0.0.1:8899";

export function WalletRoot({ children }: { children: ReactNode }) {
  // Wallet Standard discovers installed wallets on its own; listing adapters
  // explicitly only duplicates what the browser already exposes.
  const wallets = useMemo(() => [], []);
  return (
    <ConnectionProvider endpoint={RPC_URL}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          {children}
          {/* Three screens the first time a wallet connects, on every page. */}
          <Welcome />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
