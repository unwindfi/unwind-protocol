import "@/site/serif.css";

/*
 * The front page's picture, in the look of the posters (brand/x/posters.html,
 * tone "violet"): a block of violet light made from a real archive photo
 * dragged into streaks, with the glass logo sitting in it and the name set
 * big in the editorial serif along its foot.
 *
 * The light is one pre-rendered image (public/waitlist/field.webp), so the
 * page paints it in a single fetch instead of compositing blurs and filters.
 * The logo is the 3D render cut out of its blue (logo-glass.webp, from
 * brand/x/3d/keylogo.py), so the light shows through round the petals.
 *
 * It takes whatever height the page leaves under the copy.
 */
export function LightHero() {
  return (
    <div className="relative mx-3 mb-3 mt-10 min-h-[300px] flex-1 overflow-hidden rounded-[18px]
                    sm:mx-5 sm:mb-5 sm:mt-14">
      <img src="/waitlist/field.webp" alt="" fetchPriority="high"
        className="absolute inset-0 h-full w-full object-cover" />
      {/* The tagline column from the posters, quiet in the top corner. */}
      <p aria-hidden className="absolute left-5 top-5 whitespace-pre font-mono text-[10px] uppercase
                                leading-[2] tracking-[.14em] text-white/55 sm:left-8 sm:top-7 sm:text-[11px]">
        {"Permissionless perps   ·   Solana\n".repeat(3).trim()}
      </p>
      <img src="/waitlist/logo-glass.webp" alt="" fetchPriority="high"
        className="absolute left-1/2 top-[46%] w-[min(52vh,64%)] max-w-[440px] -translate-x-1/2
                   -translate-y-1/2 drop-shadow-[0_24px_40px_rgba(30,10,90,.35)]" />
      <span aria-hidden className="font-serif-display absolute bottom-3 left-4 leading-[.9] sm:bottom-5
                                   tracking-[-.035em] text-[#e2d9ff] sm:left-7"
        style={{ fontSize: "clamp(72px, 13vw, 190px)" }}>
        unwind
      </span>
    </div>
  );
}
