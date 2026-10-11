import { useState } from "react";

/*
 * The mark, final since October 11, 2026: the glass petals' silhouette in one
 * flat colour (brand/logo-final). Drawn as a mask over `currentColor`, so it
 * is white on dark and near-black on light without a second file, and any
 * parent can tint it with a text colour.
 *
 * Hovering it spins it like a wheel and lets it settle (`.chakra`).
 */
export function LogoMark({ className = "h-8 w-8", spin = true }: { className?: string; spin?: boolean }) {
  const [spinning, setSpinning] = useState(false);
  return (
    <span aria-hidden
      onPointerEnter={spin ? () => { if (!spinning) setSpinning(true); } : undefined}
      onAnimationEnd={() => setSpinning(false)}
      className={`inline-block flex-none bg-current ${className} ${spinning ? "chakra" : ""}`}
      style={MASK} />
  );
}

const MASK = {
  WebkitMaskImage: "url(/logo-mark.png)", maskImage: "url(/logo-mark.png)",
  WebkitMaskSize: "contain", maskSize: "contain",
  WebkitMaskRepeat: "no-repeat", maskRepeat: "no-repeat",
  WebkitMaskPosition: "center", maskPosition: "center",
} as const;
