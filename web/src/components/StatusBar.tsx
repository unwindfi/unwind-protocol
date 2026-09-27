/*
 * The terminal's footer: whether the venue is answering, and what is new.
 *
 * A trading screen that quietly stops updating looks exactly like a quiet
 * market. The dot is the one place that says which it is, so a trader never
 * reads a stale price as a calm one.
 */
import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { useNow } from "@/components/BatchClock";
import { cn } from "@/lib/utils";

/// Bumped when the items change, so a new set shows again to someone who
/// dismissed the last one.
const NEWS_ID = "2026-09-27";
const NEWS_KEY = "unwind.news";
const NEWS: { text: string; href?: string }[] = [
  { text: "Rewards: refer traders, earn 10% of their fees.", href: "/rewards" },
  // On this page already: the box sits under the limit price on the ticket.
  { text: "Post only orders are live." },
];

/// Three missed polls of the market list, which runs about once a second.
const STALE_MS = 4_000;

export function StatusBar({ lastOk, readOnly, cluster }: {
  /// When the market list last came back, zero before it ever has. The page
  /// already polls it, so this costs no request of its own.
  lastOk: number;
  readOnly: boolean;
  cluster?: string;
}) {
  const now = useNow(1000);
  const state = readOnly ? "readonly"
    : lastOk === 0 ? "connecting"
    : now - lastOk > STALE_MS ? "reconnecting" : "online";
  const name = cluster ? cluster[0].toUpperCase() + cluster.slice(1) : "Devnet";
  const label = state === "online" ? `${name} · Online`
    : state === "reconnecting" ? "Reconnecting"
    : state === "readonly" ? "Read-only · Live prices"
    : "Connecting";
  return (
    <footer className="flex h-7 flex-none items-center justify-between gap-3 px-3 text-[11.5px]
                       text-muted-foreground">
      <span className="flex items-center gap-2" role="status" aria-live="polite">
        <span className={cn("size-1.5 rounded-full",
          state === "online" ? "bg-up"
            : state === "reconnecting" ? "animate-pulse bg-down" : "bg-dim")} />
        {label}
      </span>
      <News />
    </footer>
  );
}

function News() {
  const [seen, setSeen] = useState(() => {
    try { return localStorage.getItem(NEWS_KEY) === NEWS_ID; } catch { return false; }
  });
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  // Closes on a click anywhere else or on Escape, without dismissing: only
  // the close button says "seen".
  useEffect(() => {
    if (!open) return;
    const click = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", click);
    window.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", click); window.removeEventListener("keydown", key); };
  }, [open]);

  if (seen) return null;
  const dismiss = () => {
    try { localStorage.setItem(NEWS_KEY, NEWS_ID); } catch { /* shows again next visit */ }
    setSeen(true);
  };

  return (
    <div ref={box} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className="flex h-5 items-center gap-1.5 rounded-full border border-line px-2 text-[11px]
                   font-medium text-foreground transition-colors hover:bg-panel2">
        New <span className="n text-dim">{NEWS.length}</span>
      </button>
      {open && (
        <div className="absolute bottom-full right-0 z-40 mb-2 w-[280px] overflow-hidden rounded-[10px]
                        border border-line bg-panel shadow-lg">
          <div className="flex items-center justify-between px-4 pb-1 pt-3">
            <span className="text-[12.5px] font-medium text-foreground">New</span>
            <button type="button" onClick={dismiss} aria-label="Dismiss" title="Dismiss"
              className="grid size-6 place-items-center rounded-full text-muted-foreground
                         transition-colors hover:bg-panel2 hover:text-foreground">
              <X size={13} />
            </button>
          </div>
          <ul className="px-4 pb-2">
            {NEWS.map((n) => (
              <li key={n.text} className="border-t border-line py-2.5 first:border-t-0">
                {n.href
                  ? <a href={n.href} className="text-[12.5px] text-foreground hover:underline">{n.text}</a>
                  : <span className="text-[12.5px] text-foreground">{n.text}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
