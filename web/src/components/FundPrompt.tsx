import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { getAccount, getBackings, usePoll } from "@/lib/api";
import { claimFaucet, faucetWaitHours } from "@/lib/tx";

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
  const backings = usePoll(() => getBackings(owner), 30_000, [owner], undefined, tick);
  const [busy, setBusy] = useState(false);

  if (!owner || !account || account.address !== owner) return null;
  const noUsdc = account.usdc === 0;
  const lowSol = account.sol != null && account.sol < LOW_SOL;
  if (!noUsdc && !lowSol) return null;
  /*
   * What the wallet has put to work. The prompt reads the wallet's own USDC,
   * so a wallet that backed a market with all of it showed "no test funds"
   * with ten thousand dollars in a market.
   */
  const placed = (backings ?? []).reduce((a, b) => a + b.value, 0)
    + account.margin + (account.lp?.value ?? 0);
  // Claimed today: no button, which would only be refused; the line says when.
  const wait = faucetWaitHours(owner);
  const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
  const next = wait ? ` Next claim in ${wait}h.` : "";
  const message = !noUsdc
    ? `Low SOL for fees.${next}`
    : placed > 0
      ? `No free USDC. ${usd(placed)} in use.${next}`
      : wait ? `No test USDC.${next}`
      : "No test funds. 10,000 USDC a day.";

  async function claim() {
    setBusy(true);
    try {
      // The toast says what was sent, or why not.
      const r = await claimFaucet(owner!);
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
        {message}
      </span>
      {!wait && <button type="button" onClick={claim} disabled={busy}
        className="press h-9 rounded-full bg-foreground px-4 text-[13px] font-medium text-background
                   transition-opacity hover:opacity-90 disabled:opacity-35">
        Get test funds
      </button>}
    </div>
  );
}
