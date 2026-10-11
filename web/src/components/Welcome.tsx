/*
 * The first time a wallet connects: three screens, once.
 *
 * What the venue is, in the words it uses everywhere else; the two ways in;
 * and what can go wrong, read and signed before anything else. The sign is a
 * message, not a transaction: it costs nothing and records that this wallet
 * saw this text. Remembered per wallet in this browser, so a second wallet
 * sees it again and a returning one does not. Closing without signing is
 * remembered too: a welcome that nags is a welcome nobody reads.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { TriangleAlert, X } from "lucide-react";
import { useWallet } from "@solana/wallet-adapter-react";
import { Checkbox } from "@/components/motion/checkbox";
import { getApy, getMarkets, post, useHasBackend, usePoll } from "@/lib/api";
import { DOCS, RISKS } from "@/site/Chrome";
import { useModalFocus } from "@/lib/hooks/use-modal-focus";
import { humanError } from "@/lib/errors";
import { LogoMark } from "@/components/LogoMark";

const KEY = (wallet: string) => `unwind.welcome:${wallet}`;
const VERSION = 1;

type Seen = { v: number; at: number; signature?: string; skipped?: boolean };
const read = (wallet: string): Seen | null => {
  try { return JSON.parse(localStorage.getItem(KEY(wallet)) ?? "null"); } catch { return null; }
};
const write = (wallet: string, seen: Seen) => {
  try { localStorage.setItem(KEY(wallet), JSON.stringify(seen)); } catch { /* shows again next time */ }
};

/// Only used by the devnet copy below; the page says what it is honestly.
const accept = (wallet: string, when: Date) =>
  `unwind devnet\n\nI have read the risk notes. I understand this is devnet with test funds, ` +
  `the program is unaudited, positions can be liquidated and backing takes first loss. ` +
  `Not investment advice.\n\nWallet: ${wallet}\nDate: ${when.toISOString()}`;

const BTN = "press inline-flex h-12 flex-1 items-center justify-center rounded-full text-[15px] font-medium " +
  "transition-opacity disabled:pointer-events-none disabled:opacity-35";
const SOLID = `${BTN} bg-foreground text-background hover:opacity-85`;
const GHOST = `${BTN} bg-panel2 text-foreground hover:bg-panel3`;
const LINK = "underline decoration-line underline-offset-4 hover:text-foreground";

/// Tells the server a wallet connected, once a browser session, so it can
/// count them (docs/devnet.md). A failed report changes nothing on the page.
const report = (body: { wallet: string; message?: string; signature?: string }) =>
  void post("/seen", body).catch(() => {});
const reportOnce = (wallet: string) => {
  try {
    if (sessionStorage.getItem(`unwind.seen:${wallet}`)) return;
    sessionStorage.setItem(`unwind.seen:${wallet}`, "1");
  } catch { /* reported again next load */ }
  report({ wallet });
};

export function Welcome() {
  const { publicKey, signMessage } = useWallet();
  const wallet = publicKey?.toBase58() ?? null;
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [path, setPath] = useState<"trade" | "earn" | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const devnet = useHasBackend() === true;

  // Opens on the first connection of a wallet this browser has not seen.
  // In development `?welcome` opens it without one, to look at it.
  const preview = import.meta.env.DEV && new URLSearchParams(location.search).has("welcome");
  const who = wallet ?? "preview";
  useEffect(() => {
    if (preview) { setOpen(true); return; }
    if (!wallet) { setOpen(false); return; }
    reportOnce(wallet);
    if (read(wallet)?.v === VERSION) return;
    setStep(0); setPath(null); setAgreed(false); setNote(null);
    setOpen(true);
  }, [wallet]);

  const dialog = useRef<HTMLDivElement>(null);
  useModalFocus(dialog, open, () => skip());

  // Live figures for the two ways in, so the screen says what is true today.
  const markets = usePoll(() => (open ? getMarkets() : Promise.resolve([])), 30_000, [open]) ?? [];
  const apy = usePoll(() => (open ? getApy() : Promise.resolve(null)), 60_000, [open]);
  const maxLev = useMemo(() => Math.max(0, ...markets.map((m) => m.maxLeverage)), [markets]);

  if (!open) return null;

  const skip = () => {
    if (!preview) write(who, { v: VERSION, at: Date.now(), skipped: true });
    setOpen(false);
  };
  const finish = async () => {
    setBusy(true); setNote(null);
    try {
      let signature: string | undefined;
      if (signMessage && wallet) {
        const message = accept(wallet, new Date());
        const sig = await signMessage(new TextEncoder().encode(message));
        signature = btoa(String.fromCharCode(...sig));
        if (!preview) report({ wallet, message, signature });
      }
      if (!preview) write(who, { v: VERSION, at: Date.now(), signature });
      setOpen(false);
      if (path === "trade" && !/^\/trade(\/|$)/.test(location.pathname)) location.href = "/trade";
      if (path === "earn" && location.pathname !== "/earn") location.href = "/earn";
    } catch (e: any) {
      setNote(/reject|denied|cancel/i.test(String(e?.message)) ? "Signature declined." : humanError(e));
    } finally { setBusy(false); }
  };

  const titles = ["unwind", "Start with", "Before you start"];

  return (
    <div ref={dialog} className="fixed inset-0 z-[90] flex items-end justify-center bg-black/60 p-0 backdrop-blur-sm
                    sm:items-center sm:p-6" role="dialog" aria-modal="true" aria-label={titles[step]}>
      <div className="pane-scroll max-h-[100dvh] w-full max-w-[560px] overflow-y-auto rounded-t-[24px] border
                      border-line bg-panel sm:max-h-[90vh] sm:rounded-[24px]">
        <div className="flex items-center gap-3 px-6 pt-6">
          <h2 className="text-balance text-[22px] font-semibold tracking-[-.02em]">{titles[step]}</h2>
          <span className="n rounded-[8px] bg-panel2 px-2 py-1 text-[12.5px] text-muted-foreground">{step + 1} / 3</span>
          <button type="button" onClick={skip} aria-label="Close"
            className="ml-auto grid size-9 place-items-center rounded-full text-muted-foreground
                       transition-colors hover:bg-panel2 hover:text-foreground">
            <X size={18} />
          </button>
        </div>

        {step === 0 && (
          <div className="px-6 pb-6 pt-5">
            <div className="relative h-[150px] overflow-hidden rounded-[16px] bg-panel2">
              <img src="/waitlist/field.webp" alt="" className="h-full w-full object-cover" />
              <LogoMark
                className="absolute left-1/2 top-1/2 h-16 w-16 -translate-x-1/2 -translate-y-1/2 text-white" />
            </div>
            <div className="mt-4 flex flex-col">
              <Fact n={1} title="You sign every order" />
              <Fact n={2} title="One price per batch" />
              <Fact n={3} title="Every parameter on chain" />
            </div>
            <p className="mt-2 text-[13px] text-muted-foreground">
              <a href={`${DOCS}/about-unwind/about`} target="_blank" rel="noreferrer" className={LINK}>Docs</a>
            </p>
            <div className="mt-6 flex gap-3">
              <button type="button" onClick={skip} className={GHOST}>Skip</button>
              <button type="button" onClick={() => setStep(1)} className={SOLID}>Continue</button>
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="px-6 pb-6 pt-5">
            <div className="grid gap-3 sm:grid-cols-2">
              <Path on={path === "trade"} onClick={() => setPath("trade")} tag="Trade" tone="text-up bg-up/10"
                figure={markets.length ? `${markets.length} markets, up to ${maxLev}x` : "Loading markets"} />
              <Path on={path === "earn"} onClick={() => setPath("earn")} tag="Earn" tone="text-foreground bg-panel3"
                figure={apy?.pool?.apy != null ? `Pool APY ${apy.pool.apy.toFixed(2)}%` : "Pool APY not measured yet"} />
            </div>
            <div className="mt-6 flex gap-3">
              <button type="button" onClick={() => setStep(0)} className={GHOST}>Back</button>
              <button type="button" onClick={() => setStep(2)} className={SOLID}>
                {path ? "Continue" : "Decide later"}
              </button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="px-6 pb-6 pt-5">
            <div className="flex gap-3 rounded-[14px] bg-[#f5b8201a] px-4 py-3.5 text-[14px] leading-[1.5]">
              <TriangleAlert size={18} className="mt-0.5 flex-none text-[#d9a21b]" />
              <p>
                <span className="font-medium">{devnet ? "Devnet." : "Read-only."}</span>{" "}
                {devnet
                  ? "Test USDC, no value. Unaudited. Devnet activity counts toward mainnet rewards."
                  : "Devnet offline. Prices live, trading paused."}
              </p>
            </div>
            <div className="mt-3 flex flex-col gap-2.5">
              <Risk n={1} title="Liquidation can take your whole margin." />
              <Risk n={2} title="Backers lose first, then the pool." />
              <Risk n={3} title="Orders pause when the price feed lags." />
            </div>
            <Checkbox checked={agreed} onCheckedChange={setAgreed} className="mt-4 items-start gap-3 [&_span]:text-[14px] [&_span]:leading-[1.5]"
              label="I understand: devnet, unaudited, not investment advice." />
            <p className="text-pretty mt-3 text-[13px] leading-[1.5] text-muted-foreground">
              Signing is free.{" "}
              <a href={RISKS} target="_blank" rel="noreferrer" className={LINK}>Risks</a>
            </p>
            {note && <p className="mt-2 text-[13px] text-down">{note}</p>}
            <div className="mt-6 flex gap-3">
              <button type="button" onClick={() => setStep(1)} className={GHOST}>Back</button>
              <button type="button" onClick={finish} disabled={!agreed || busy} className={SOLID}>
                {busy ? "Waiting for your wallet" : path === "earn" ? "Earn" : path === "trade" ? "Trade" : "Start"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/// One fact, by name. Numbered rows on a hairline, rather than three
/// icon-in-a-tile cards; the reasons live in the docs.
function Fact({ n, title }: { n: number; title: string }) {
  return (
    <div className="flex gap-4 border-t border-line py-3.5 first:border-t-0">
      <span className="n w-5 flex-none pt-0.5 text-[13px] text-dim">{String(n).padStart(2, "0")}</span>
      <div className="text-[15px] font-medium">{title}</div>
    </div>
  );
}

function Path({ on, onClick, tag, tone, figure }: {
  on: boolean; onClick: () => void; tag: string; tone: string; figure: string;
}) {
  return (
    <button type="button" onClick={onClick} aria-pressed={on}
      className={`flex flex-col rounded-[16px] border p-4 text-left transition-colors ${
        on ? "border-foreground bg-panel2" : "border-line hover:bg-panel2"}`}>
      <span className={`w-full rounded-[8px] px-3 py-2 text-[14px] font-medium ${tone}`}>{tag}</span>
      <span className="n mt-3 text-[13.5px] font-medium">{figure}</span>
    </button>
  );
}

function Risk({ n, title }: { n: number; title: string }) {
  return (
    <div className="flex items-center gap-4 rounded-[14px] border border-line px-4 py-3">
      <span className="n grid size-8 flex-none place-items-center rounded-full bg-panel2 text-[13px]">{n}</span>
      <div className="text-[15px] font-medium">{title}</div>
    </div>
  );
}
