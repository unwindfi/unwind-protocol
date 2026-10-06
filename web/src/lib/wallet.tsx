import { useMemo, type ReactNode } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { UnsafeBurnerWalletAdapter } from "@solana/wallet-adapter-unsafe-burner";
import { Keypair } from "@solana/web3.js";

/// The dev burner, keeping one test key in this browser's storage rather
/// than making a new one on every connect (each new key needed the faucet
/// again). Development builds only.
class DevBurnerWalletAdapter extends UnsafeBurnerWalletAdapter {
  async connect() {
    const KEY = "unwind.devBurner";
    let kp: Keypair;
    try {
      const saved = localStorage.getItem(KEY);
      kp = saved ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(saved))) : Keypair.generate();
      if (!saved) localStorage.setItem(KEY, JSON.stringify(Array.from(kp.secretKey)));
    } catch { kp = Keypair.generate(); }
    (this as unknown as { _keypair: Keypair })._keypair = kp;
    this.emit("connect", kp.publicKey);
  }
}
import { Welcome } from "@/components/Welcome";
import { WalletPickerProvider } from "@/components/WalletPicker";

/// The validator this app is served from. A wallet must be pointed at the same
/// cluster, which for a throwaway localnet means adding it as a custom RPC —
/// hence the demo account staying available alongside.
export const RPC_URL = import.meta.env.VITE_RPC_URL ?? "http://127.0.0.1:8899";

export function WalletRoot({ children }: { children: ReactNode }) {
  // Wallet Standard discovers installed wallets on its own; listing adapters
  // explicitly only duplicates what the browser already exposes.
  // In development only, a throwaway burner wallet as well: a test keypair
  // in this browser's storage that signs without a popup, so every flow can
  // be exercised end to end on localhost. Production builds never offer it.
  const wallets = useMemo(() => (import.meta.env.DEV ? [new DevBurnerWalletAdapter()] : []), []);
  return (
    <ConnectionProvider endpoint={RPC_URL}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletPickerProvider>
          {children}
          {/* Three screens the first time a wallet connects, on every page. */}
          <Welcome />
        </WalletPickerProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
