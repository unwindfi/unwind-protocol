import { LogoMark } from "@/components/LogoMark";
import { Wordmark } from "@/components/Wordmark";

/*
 * The front page's picture, in the look of the posters (brand/x/posters.html,
 * tone "violet"): a block of violet light made from a real archive photo
 * dragged into streaks, with the glass logo sitting in it and the wordmark
 * set big along its foot.
 *
 * The light is one pre-rendered image (public/waitlist/field.webp), so the
 * page paints it in a single fetch instead of compositing blurs and filters.
 * The logo is the final flat mark (LogoMark, brand/logo-final) in white, so
 * the light shows through round the petals.
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
      <p aria-hidden className="absolute left-5 top-5 whitespace-pre font-mono text-[10.5px] uppercase
                                leading-[2] tracking-[.14em] text-white/55 sm:left-8 sm:top-7 sm:text-[11px]">
        {"Permissionless perps   ·   Solana\n".repeat(3).trim()}
      </p>
      <LogoMark
        className="absolute left-1/2 top-[46%] aspect-square w-[min(45vh,55%)] max-w-[380px] -translate-x-1/2
                   -translate-y-1/2 text-white drop-shadow-[0_24px_40px_rgba(30,10,90,.35)]" />
      <div aria-hidden className="absolute bottom-4 left-4 text-[#e2d9ff] sm:bottom-6 sm:left-7">
        <Wordmark className="h-[clamp(52px,9.5vw,140px)] w-auto" />
      </div>
    </div>
  );
}
