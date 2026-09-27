import { Suspense, lazy, useEffect, useRef, useState } from "react";
/// The rest of the site sets headings at 600. This page sets one at 500,
/// four times the size -- so the weight it needs is loaded here, in its own
/// chunk, rather than on every page that will never draw a character in it.
import "@fontsource/inter/500.css";
import { ArrowUpRight, ChevronDown, Volume2, VolumeX } from "lucide-react";
import { LightHero } from "@/components/LightHero";
import { OUTLINE, Shell } from "@/site/Chrome";
/// The serif of the "unwind" lockup.
import "@/site/serif.css";
import { PLAYER_NODE, Radio as RadioEngine } from "@/lib/radio";
import type { Me } from "@/site/WaitlistJoined";

/// The signed-in panel carries the motion library for its counter, which a
/// visitor who has not joined never sees -- so it loads only for those who have.
const Joined = lazy(() => import("@/site/WaitlistJoined").then((m) => ({ default: m.Joined })));

/// unwind on X.
const X_URL = "https://x.com/unwindfi";

/// The documentation: a GitBook site synced from `docs/` in this repo,
/// rather than a route this app serves.
const DOCS = "https://unwind.gitbook.io/unwind-docs";

/// The X mark, since the icon set carries no brand marks.
const XMark = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
  </svg>
);

/*
 * Joining is signing in with X. The button is a plain link to the function
 * that starts the handshake, carrying the referrer's handle if the visitor
 * came through someone's link; X sends them back signed in, or with a
 * reason in the query string. No form, no field, nothing to validate: a
 * handle is harder to fake than an address and easier to reach.
 */
function Join() {
  const [help, setHelp] = useState(false);
  const q = new URLSearchParams(typeof location === "undefined" ? "" : location.search);
  const ref = q.get("ref");
  const error = q.get("error");

  // Closing on Escape is the one overlay habit worth keeping: the panel is
  // inline, but it is still the thing that just opened.
  useEffect(() => {
    if (!help) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setHelp(false); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [help]);

  return (
    <div>
      {/*
       * Two pills, after the /list card: the one thing the page asks for is
       * inverted monochrome with the X mark in it, and the explainer beside
       * it is the outlined pill every other secondary action uses.
       */}
      <div className="flex flex-wrap items-center justify-center gap-3 max-sm:gap-2">
        <a href={ref ? `/api/x/start?ref=${encodeURIComponent(ref)}` : "/api/x/start"}
          className="press flex h-[48px] items-center gap-2.5 rounded-full bg-foreground px-6
                     text-[14px] font-medium text-background transition-opacity
                     hover:opacity-90 max-sm:px-5">
          <XMark size={15} />
          Connect X
        </a>
        <button type="button" onClick={() => setHelp((h) => !h)}
          aria-expanded={help} aria-controls="what-panel"
          className={`${OUTLINE} flex h-[48px] items-center !py-0 !text-[14px] max-sm:px-5
                      ${help ? "border-foreground/40" : ""}`}>
          1) What
        </button>
      </div>
      {/* What the button does, in the order it happens: connecting an
          account is not obviously the same as joining anything. */}
      <p className="mt-4 text-[13px] leading-relaxed text-muted-foreground">
        Connect X. Join the waitlist. Get early access.
      </p>
      {error && (
        <p className="mt-4 text-[13px] leading-relaxed text-down">{error}</p>
      )}

      {/*
       * Three lines, none longer than a breath: the assets, where the price
       * comes from, and who is allowed to list. Set as the key and value
       * rows the /list preview uses.
       *
       * It opens in place rather than over the page. The open and shut is a
       * grid row going from 0fr to 1fr, which is how you animate to a height
       * you do not know.
       */}
      <div id="what-panel" className="grid transition-[grid-template-rows] duration-300
                                      ease-[cubic-bezier(0.16,1,0.3,1)]"
        style={{ gridTemplateRows: help ? "1fr" : "0fr" }}>
        <div className="overflow-hidden">
          {/* Sized to the column, not the viewport: the wrapper above clips
              for the open animation, so anything wider loses its right edge. */}
          <div className={`mx-auto mt-5 w-full max-w-[440px] rounded-[24px] border border-line
                           bg-panel2 px-5 pb-2 pt-4 text-left transition-opacity duration-200
                           ${help ? "opacity-100" : "opacity-0"}`}>
            <p className="pb-3 text-[15px] font-medium">What unwind is</p>
            <dl className="text-[13px] leading-[1.5]">
              {WHAT.map(([k, v]) => (
                <div key={k} className="flex gap-4 border-t border-line py-3">
                  <dt className="w-[52px] flex-none text-muted-foreground">{k}</dt>
                  <dd className="min-w-0 text-foreground">{v}</dd>
                </div>
              ))}
              {/* The mechanism pages live in GitBook, not in this app. */}
              <div className="border-t border-line py-3">
                <a href={DOCS} target="_blank" rel="noreferrer"
                  className="inline-flex items-center gap-1 font-medium text-foreground
                             underline-offset-4 hover:underline">
                  Read the docs
                  <ArrowUpRight size={14} className="text-muted-foreground" />
                </a>
              </div>
            </dl>
          </div>
        </div>
      </div>
    </div>
  );
}

/// The three answers the explainer gives, in the order a visitor asks them.
const WHAT: [string, string][] = [
  ["What", "Memecoins, majors, tokenised equities."],
  ["How", "Price is set by two-sided flow, not by a pool."],
  ["Who", "Anyone can open a market."],
];

/*
 * One screen, and nothing under it.
 *
 * A waitlist page has exactly one thing to ask for, and every element added
 * is another thing between the reader and asking. So the page is the height
 * of the window and carries two things: the claim, and the button.
 */
/// In dev there is no API behind the proxy, so a `?demo` query stands in a
/// made-up account to work on the dashboard with; `?demo=full` gives it
/// referrals. Decided once, when state is first made, not in an effect.
function demoMe(): Me | undefined {
  if (!import.meta.env.DEV || !location.search.includes("demo")) return undefined;
  const full = location.search.includes("demo=full");
  return {
    id: "1", handle: "0xprarimz", link: `${location.origin}/waitlist?ref=0xprarimz`,
    referrals: full ? [
      { ts: new Date(Date.now() - 6e4).toISOString(), id: "2", handle: "demo_one" },
      { ts: new Date(Date.now() - 7.2e6).toISOString(), id: "3", handle: "demo_two" },
    ] : [],
  };
}

/*
 * The sound control.
 *
 * The audio itself lives in lib/radio, because which source is playing
 * decides whether the mark can follow it, and that is not a question a
 * button should be answering.
 */
function Radio({ on, onChange }: {
  on: boolean;
  onChange: (playing: boolean, analysed: boolean) => void;
}) {
  const engine = useRef<RadioEngine>(null);

  async function toggle() {
    engine.current ??= new RadioEngine();
    try {
      const playing = await engine.current.toggle(on);
      onChange(playing, engine.current.analysed);
    } catch {
      /* blocked, offline, or not embeddable: the button does nothing */
    }
  }

  return (
    <button type="button" onClick={toggle} aria-pressed={on}
      aria-label={on ? "Turn the music off" : "Turn the music on"}
      className="press flex items-center text-muted-foreground transition-colors
                 hover:text-foreground">
      {on ? <Volume2 size={17} /> : <VolumeX size={17} />}
    </button>
  );
}

/// Who is signed in, or null. Never throws: a dead API is a signed-out page.
async function fetchMe(): Promise<Me | null> {
  try {
    const r = await fetch("/api/me", { credentials: "same-origin" });
    return r.ok ? ((await r.json()) as Me) : null;
  } catch {
    return null;
  }
}

/*
 * Who was signed in last time, so the page can draw the right panel on the
 * first frame instead of waiting a round trip for /api/me. The answer from
 * the server replaces it a moment later; storage that throws is no memory.
 */
const ME_KEY = "unwind.me";
function rememberedMe(): Me | null {
  try {
    const raw = sessionStorage.getItem(ME_KEY);
    return raw ? (JSON.parse(raw) as Me) : null;
  } catch {
    return null;
  }
}

function useMe() {
  const [me, setMe] = useState<Me | null>(() => demoMe() ?? rememberedMe());
  useEffect(() => {
    if (demoMe()) return;
    void fetchMe().then((m) => {
      setMe(m);
      try {
        if (m) sessionStorage.setItem(ME_KEY, JSON.stringify(m));
        else sessionStorage.removeItem(ME_KEY);
      } catch { /* private mode: nothing to remember */ }
    });
  }, []);
  return { me };
}

export default function Waitlist() {
  const { me } = useMe();
  const [sound, setSound] = useState(false);
  return (
    /*
     * The page is one big card, the way /list is: a hairline rounded panel
     * inset from the window, with the page colour showing round it. The logo
     * and the account controls sit in its corners rather than in a header
     * bar, so nothing draws a line across it.
     */
    <div className="site flex min-h-dvh flex-col bg-background p-3 sm:p-5">
      <div className="relative isolate flex flex-1 flex-col overflow-hidden rounded-[24px]
                      border border-line bg-panel">
        {/* Where YouTube's player goes. One pixel, out of the way. */}
        <div id={PLAYER_NODE} aria-hidden
          className="pointer-events-none absolute bottom-0 left-0 h-px w-px opacity-0" />

        <a href="/" className="absolute left-6 top-6 z-20 flex items-center gap-1.5
                               sm:left-10 sm:top-9">
          {/* The glass logo and the serif name, as on the X profile. The mark is the render cropped to
              its petals (logo-glass-mark.webp), so its box is all logo. A faint violet
              glow behind the logo keeps its translucent petals from greying out on
              the dark card; the serif sits a touch low to centre its x-height on it. */}
          <img src="/waitlist/logo-glass-mark.webp" alt=""
            className="h-9 w-9 drop-shadow-[0_0_10px_rgba(120,80,240,.55)]" />
          <span className="font-serif-display translate-y-[2px] text-[32px] leading-none tracking-[-.02em]">
            unwind
          </span>
        </a>
        <nav className="absolute right-6 top-6 z-20 flex items-center gap-4 sm:right-10 sm:top-9">
          {me && (
            <details className="relative">
              <summary className="flex h-[36px] cursor-pointer list-none items-center gap-1.5
                                  rounded-full border border-line bg-panel2 pl-3.5 pr-2.5
                                  text-[13px] font-medium transition-colors
                                  hover:border-foreground/40">
                @{me.handle}
                <ChevronDown size={14} className="text-muted-foreground" />
              </summary>
              <div className="absolute right-0 top-[calc(100%+8px)] min-w-[160px] rounded-[16px]
                              border border-line bg-panel2 p-1.5 text-[13px] shadow-lg">
                <a href={`https://x.com/${me.handle}`} target="_blank" rel="noreferrer"
                  className="block rounded-[10px] px-3 py-2 hover:bg-panel3">Open X profile</a>
                <a href="/api/x/logout" className="block rounded-[10px] px-3 py-2 hover:bg-panel3">
                  Sign out
                </a>
              </div>
            </details>
          )}
          {/* Following needs no account and no handshake, so it stays out of the
              row that asks for one and sits up here with the sound. */}
          <a href={X_URL} target="_blank" rel="noreferrer" aria-label="unwind on X"
            className="text-muted-foreground transition-colors hover:text-foreground">
            <XMark size={15} />
          </a>
          <Radio on={sound} onChange={(playing) => setSound(playing)} />
        </nav>

        {/* The copy on top, the violet light in whatever height is left under it. */}
        <main className="relative isolate flex flex-1 flex-col overflow-hidden pt-[max(9vh,92px)] max-sm:pt-[26%]">
          <Shell className="relative z-10 flex flex-col items-center text-center">
            {/* Plain type in two tones, nothing tinted and nothing glowing. */}
            <h1 className="max-w-[34ch] text-[clamp(1.9rem,4.3vw,3.1rem)] leading-[1.08]
                           tracking-[-.035em] text-foreground"
              style={{ fontWeight: 500 }}>
              Permissionless perps on{" "}
              <span className="whitespace-nowrap text-muted-foreground">any asset.</span>
            </h1>
            {/* Drawn on the first frame from the remembered answer (see useMe),
                and corrected once the server replies. */}
            <div className="mt-7 w-full">
              {me ? <Suspense fallback={null}><Joined me={me} /></Suspense> : <Join />}
            </div>
          </Shell>
          <LightHero />
        </main>
      </div>
    </div>
  );
}
