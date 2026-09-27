import "@/site/serif.css";
import { OUTLINE, SOLID, SiteHeader } from "@/site/Chrome";

/*
 * An address nobody claimed, in the unlocked site. It used to open the trade
 * app, which read as the site ignoring what you typed; now it says so, on the
 * front page's violet light, and offers the two places people actually go.
 */
export default function NotFound() {
  return (
    <div className="site relative min-h-full">
      <SiteHeader />
      <main className="relative mx-3 mb-3 mt-3 flex min-h-[70vh] items-center justify-center
                       overflow-hidden rounded-[18px] sm:mx-5 sm:mb-5 sm:mt-5">
        <img src="/waitlist/field.webp" alt="" aria-hidden
          className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-80" />
        <div className="relative flex flex-col items-center px-6 py-16 text-center">
          <img src="/waitlist/logo-glass-mark.webp" alt="" className="h-20 w-20" />
          <h1 className="font-serif-display mt-6 text-[clamp(3rem,9vw,5.5rem)] leading-none
                         tracking-[-.025em] text-[#ece9fb]">
            Nothing here.
          </h1>
          <p className="mt-4 max-w-[36ch] text-[15px] leading-relaxed text-[#dcd6fb]">
            No page lives at <span className="font-mono text-[13px]">{location.pathname}</span>.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <a href="/markets" className={SOLID}>See markets</a>
            <a href="/" className={OUTLINE}>Front page</a>
          </div>
        </div>
      </main>
    </div>
  );
}
