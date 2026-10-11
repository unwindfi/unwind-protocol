/*
 * The mark, final since October 11, 2026: the glass petals' silhouette in one
 * flat colour (brand/logo-final). Drawn as a mask over `currentColor`, so it
 * is white on dark and near-black on light without a second file, and any
 * parent can tint it with a text colour. It holds still: the hover spin it
 * used to have played on every tap on a phone.
 */
export function LogoMark({ className = "h-8 w-8" }: { className?: string }) {
  return <span aria-hidden className={`inline-block flex-none bg-current ${className}`} style={MASK} />;
}

const MASK = {
  WebkitMaskImage: "url(/logo-mark.png)", maskImage: "url(/logo-mark.png)",
  WebkitMaskSize: "contain", maskSize: "contain",
  WebkitMaskRepeat: "no-repeat", maskRepeat: "no-repeat",
  WebkitMaskPosition: "center", maskPosition: "center",
} as const;
