import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { getAccount, post, usePoll } from "@/lib/api";

/// Below this a wallet cannot pay the rent a listing or a first deposit
/// needs; the faucet tops it up under the same line.
const LOW_SOL = 0.025;

/*
 * The faucet, for pages other than the trade screen.
 *
 * It used to live only in the order ticket, so someone who came straight to
 * list or back a market with a new wallet had no test USDC and no SOL for
 * rent, and nothing on the page said where to get either. Shown only while
 * the connected wallet is short of one of them.
 */
export function FundPrompt({ onFunded }: { onFunded?: () => void }) {
  const owner = useWallet().publicKey?.toBase58();
  const [tick, setTick] = useState(0);
  const account = usePoll(() => getAccount(owner), 10_000, [owner], undefined, tick);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  if (!owner || !account || account.address !== owner) return null;
  const short = account.usdc === 0 || (account.sol != null && account.sol < LOW_SOL);
  if (!short && !note) return null;

  async function claim() {
    setBusy(true);
    try {
      const r = await post("/faucet", { owner }) as { ok: boolean; error?: string; usdc?: number; sol?: number };
      setNote(r.ok
        ? `Sent ${(r.usdc ?? 0).toLocaleString()} test USDC` + (r.sol ? ` and ${r.sol} SOL` : "") + "."
        : r.error ?? "The faucet failed.");
      setTick((t) => t + 1);
      if (r.ok) onFunded?.();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[16px] border border-line
                    bg-panel px-5 py-3 text-[13px]">
      <span className="min-w-0 flex-1 text-muted-foreground">
        {note ?? "This wallet has no test funds yet. One claim a day gives 10,000 test USDC, and SOL for rent and fees."}
      </span>
      {short && (
        <button type="button" onClick={claim} disabled={busy}
          className="press h-9 rounded-full bg-foreground px-4 text-[13px] font-medium text-background
                     transition-opacity hover:opacity-90 disabled:opacity-40">
          Get test funds
        </button>
      )}
    </div>
  );
}
