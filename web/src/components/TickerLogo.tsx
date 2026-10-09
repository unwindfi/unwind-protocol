import { useEffect, useState } from "react";
import { logoSrc, type Market } from "@/lib/api";

/// Real logo when one exists at /logos/<symbol>.svg, else the token's own
/// logo through the server, monogram otherwise.
export function TickerLogo({ m, size = 26, bare = false }: {
  m: Market; size?: number;
  /// No dark disc behind a real logo: for a small icon beside a word, where
  /// a disc reads as a second, darker shape.
  bare?: boolean;
}) {
  // Official xStocks artwork ships as PNG; the hand-drawn SVGs are the
  // fallback for anything it does not cover; then the real token's own logo,
  // through the server. Each is loaded before it is shown, so a slow or
  // missing one leaves the monogram in place rather than a broken image.
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setSrc(null);
    // A token marked per thousand or million is listed as `1MBONK`; its
    // logo is the token's own.
    const file = m.symbol.replace(/^1[KMB](?=[A-Z])/, "");
    const tries = [`/logos/${file}.png`, `/logos/${file}.svg`, logoSrc(m.icon)]
      .filter((u): u is string => !!u);
    (async () => {
      for (const url of tries) {
        const loaded = await new Promise<boolean>((res) => {
          const img = new Image();
          img.onload = () => res(true);
          img.onerror = () => res(false);
          img.src = url;
        });
        if (!alive) return;
        if (loaded) { setSrc(url); return; }
      }
    })();
    return () => { alive = false; };
  }, [m.symbol, m.icon]);

  return (
    <span className="grid flex-none place-items-center overflow-hidden rounded-full font-bold text-white"
      style={{ width: size, height: size, background: src ? (bare ? "transparent" : "var(--color-panel3)") : m.color,
               fontSize: size * 0.45 }}>
      {src ? <img src={src} alt="" onError={() => setSrc(null)} style={{ width: bare ? "100%" : "86%", height: bare ? "100%" : "86%" }} />
           : m.mono}
    </span>
  );
}
