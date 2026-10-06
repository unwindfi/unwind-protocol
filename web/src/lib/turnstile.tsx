/*
 * The human check before a faucet claim: Cloudflare Turnstile.
 *
 * Every faucet button goes through claimFaucet, and claimFaucet asks here
 * first. The script is loaded the first time someone claims, not with the
 * page, so nobody who never uses the faucet loads it. With no
 * VITE_TURNSTILE_SITE_KEY in the build there is no check, and the server
 * skips its side too unless TURNSTILE_SECRET is set there.
 */
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

const SITE_KEY: string | undefined = import.meta.env.VITE_TURNSTILE_SITE_KEY || undefined;
const SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

let loading: Promise<any> | null = null;
function loadTurnstile(): Promise<any> {
  const w = window as any;
  if (w.turnstile) return Promise.resolve(w.turnstile);
  return (loading ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SCRIPT;
    s.async = true;
    s.onload = () => (w.turnstile ? resolve(w.turnstile) : reject(new Error("no turnstile")));
    s.onerror = () => { loading = null; s.remove(); reject(new Error("turnstile did not load")); };
    document.head.appendChild(s);
  }));
}

/// A token for one claim, or null when the person closed the check.
/// Undefined when this build has no site key, so there is nothing to ask.
export function humanToken(): Promise<string | null | undefined> {
  if (!SITE_KEY) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const done = (token: string | null) => {
      root.unmount();
      host.remove();
      resolve(token);
    };
    root.render(<Check siteKey={SITE_KEY} onDone={done} />);
  });
}

function Check({ siteKey, onDone }: { siteKey: string; onDone: (token: string | null) => void }) {
  const slot = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let id: string | undefined;
    let api: any;
    let gone = false;
    setError(null);
    loadTurnstile().then((t) => {
      if (gone || !slot.current) return;
      api = t;
      id = t.render(slot.current, {
        sitekey: siteKey,
        action: "faucet",
        theme: document.documentElement.dataset.theme === "dark" ? "dark" : "light",
        callback: (token: string) => onDone(token),
        "error-callback": () => { setError("The check failed. Try again."); return true; },
        "expired-callback": () => setError("The check expired. Try again."),
      });
    }).catch(() => {
      if (!gone) setError("The check could not load. Check your connection, or turn off a blocker for this site.");
    });
    return () => {
      gone = true;
      if (api && id !== undefined) { try { api.remove(id); } catch { /* already gone */ } }
    };
  }, [siteKey, attempt, onDone]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onDone(null); };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [onDone]);

  return (
    <div className="fixed inset-0 z-[95] flex items-end justify-center bg-black/60 sm:items-center sm:p-6"
      role="dialog" aria-modal="true" aria-label="Get test funds"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onDone(null); }}>
      <div className="w-full max-w-[400px] rounded-t-[12px] border border-line bg-panel px-5 pb-5 pt-5
                      sm:rounded-[12px]">
        <h2 className="text-[15px] font-medium">Get test funds</h2>
        <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
          One check before the faucet sends: 10,000 test USDC a wallet a day.
        </p>
        <div ref={slot} key={attempt} className="mt-4 flex min-h-[65px] items-center justify-center" />
        {error && <p className="mt-3 text-[13px] text-muted-foreground">{error}</p>}
        <div className="mt-4 flex gap-2">
          {error && (
            <button type="button" onClick={() => setAttempt((a) => a + 1)}
              className="press h-10 flex-1 rounded-[8px] bg-foreground text-[13.5px] font-medium text-background
                         transition-opacity hover:opacity-90">
              Try again
            </button>
          )}
          <button type="button" onClick={() => onDone(null)}
            className="press h-10 flex-1 rounded-[8px] border border-line text-[13.5px] font-medium
                       transition-colors hover:bg-panel2">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
