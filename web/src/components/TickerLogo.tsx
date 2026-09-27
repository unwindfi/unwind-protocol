import { useEffect, useState } from "react";
import type { Market } from "@/lib/api";

/// Real logo when one exists at /logos/<symbol>.svg, monogram otherwise.
export function TickerLogo({ m, size = 26 }: { m: Market; size?: number }) {
  // Official xStocks artwork ships as PNG; the hand-drawn SVGs are the
  // fallback for anything it does not cover.
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setSrc(null);
    (async () => {
      for (const ext of ["png", "svg"]) {
        // A token marked per thousand or million is listed as `1MBONK`; its
        // logo is the token's own.
        const url = `/logos/${m.symbol.replace(/^1[KMB](?=[A-Z])/, "")}.${ext}`;
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
  }, [m.symbol]);

  return (
    <span className="grid flex-none place-items-center overflow-hidden rounded-full font-bold text-white"
      style={{ width: size, height: size, background: src ? "#111826" : m.color,
               fontSize: size * 0.45 }}>
      {src ? <img src={src} alt="" style={{ width: "86%", height: "86%" }} />
           : m.mono}
    </span>
  );
}
