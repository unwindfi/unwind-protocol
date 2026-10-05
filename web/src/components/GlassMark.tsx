/*
 * The mark: the glass petals rendered from brand/x/3d/petals.py in the brand
 * violet (tint 0.40,0.24,0.92, edge 0.70,0.62,0.98), the same in both themes.
 * The violet holds its edges on a pale ground, where the older milky glass
 * disappeared, and reads as well on dark. Never redrawn as a flat SVG.
 */
export function GlassMark({ className = "h-8 w-8" }: { className?: string }) {
  return <img src="/waitlist/logo-glass-mark.webp" alt="" aria-hidden className={className} />;
}
