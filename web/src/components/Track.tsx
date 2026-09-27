/*
 * The road behind the search.
 *
 * A main lane runs the full width at exactly the height of the search field,
 * with branches dropping onto it from above and slip roads leaving below, so
 * it reads as a route the field is standing on rather than a rule across the
 * page.
 *
 * Two things here are load-bearing.
 *
 * It is anchored to the field, not to the section: the lane sits at the
 * middle of this box and the box is centred on the input, which is the only
 * way the two line up without a number here knowing the hero's padding, the
 * headline's leading and the field's height all at once.
 *
 * And the viewBox is measured rather than fixed, so one unit is one pixel. A
 * fixed viewBox has to be fitted to the box somehow and both answers are
 * wrong: `slice` scales to cover and crops, so at most widths the left of the
 * drawing is off-screen and every station with it, while `none` stretches the
 * corners into ellipses and leaves the vertical runs thinner than the
 * horizontal ones. Measuring avoids the choice.
 *
 * Nothing is cut out for the field. The lane is drawn straight through and
 * the field, which is opaque, sits on top: a gap would have to know how wide
 * the field is, and would stop being a gap the moment it changed.
 */
import { useEffect, useId, useRef, useState } from "react";
import type { Market } from "@/lib/api";
import { TickerLogo } from "@/components/TickerLogo";

const H = 380;
const LANE = H / 2;
/*
 * How far above the lane the branches run, and how tight the corners are.
 *
 * Both are read from the width rather than fixed, because the headline above
 * the field drops onto a second line long before a phone runs out of road: at
 * 74 above the lane the branches came in through the middle of it, and the
 * traffic on them crossed the type. Keeping them nearer the lane on a narrow
 * screen puts the whole drawing in the gap between the headline and the
 * field, which is the only place it can be without competing with either.
 *
 * The box itself does not change size. It is transparent above the branches
 * and the section clips it, so an unused strip there costs nothing, while a
 * shorter box would have to be scaled to fit and the road would go with it.
 */
const NARROW = 640;
const upperOf = (w: number) => (w < NARROW ? 138 : 74);
const cornerOf = (w: number) => (w < NARROW ? 24 : 40);
/*
 * The logo rides inside the tarmac rather than straddling it, so its size is
 * the road's width less a hair of margin, not a number of its own. A fixed
 * size was more than twice the road at most widths, which made the traffic
 * look dropped on top of the drawing instead of travelling along it.
 */
const FIT = 0.94;

/// Corners and slip roads as fractions of the width, so the shape is the same
/// on a laptop as on a monitor.
const TURN = 0.15;
const SLIP = 0.3;

/// A slip road: leaves the lane and runs off the bottom of the box.
const slip = (w: number, dir: 1 | -1) => {
  const x = dir === 1 ? w * SLIP : w * (1 - SLIP);
  const R = cornerOf(w);
  return [
    `M ${x - dir * R * 2.4} ${LANE}`,
    `H ${x - dir * R}`,
    `Q ${x} ${LANE} ${x} ${LANE + R}`,
    `V ${H}`,
  ].join(" ");
};

/*
 * The journey every logo makes: in along the upper lane on the left, down
 * the bend, the length of the main lane behind the field, up the far bend,
 * and out along the upper lane on the right.
 *
 * One route, and that is the point. Traffic on separate routes that merge
 * has to be kept apart by timing, and timing cannot do it: two loops of
 * different lengths drift against each other and eventually put two logos on
 * the same yard of tarmac. Everything sharing one path at one speed, spaced
 * by an even share of the loop, cannot collide at all -- the gaps are fixed
 * by construction rather than by arithmetic that has to keep coming out.
 */
const journey = (w: number) => {
  const xL = w * TURN, xR = w * (1 - TURN);
  const UPPER = upperOf(w), R = cornerOf(w);
  return [
    `M 0 ${UPPER}`,
    `H ${xL - R}`,
    `Q ${xL} ${UPPER} ${xL} ${UPPER + R}`,
    `V ${LANE - R}`,
    `Q ${xL} ${LANE} ${xL + R} ${LANE}`,
    `H ${xR - R}`,
    `Q ${xR} ${LANE} ${xR} ${LANE - R}`,
    `V ${UPPER + R}`,
    `Q ${xR} ${UPPER} ${xR + R} ${UPPER}`,
    `H ${w}`,
  ].join(" ");
};

/// How many are on the road at once, and how long the trip takes.
const CARRIES = 7;
const SECONDS = 26;

export function Track({ markets, className = "" }: {
  markets: Market[];
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  /// Ids have to be unique per instance, or a second road steals the first's
  /// paths and every logo on both follows one of them.
  const uid = useId().replace(/:/g, "");
  const [still, setStill] = useState(false);

  useEffect(() => {
    const q = window.matchMedia("(prefers-reduced-motion: reduce)");
    const read = () => setStill(q.matches);
    read();
    q.addEventListener("change", read);
    return () => q.removeEventListener("change", read);
  }, []);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const read = () => setW(el.getBoundingClientRect().width);
    read();
    // The box is the width of the window, so this fires on every resize.
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /*
   * One flat list of everything on the road: which route it runs, how long
   * that loop takes, and how far into it this one starts.
   */
  const traffic = markets.length && w
    ? Array.from({ length: CARRIES }, (_, i) => ({
        delay: -(i * SECONDS) / CARRIES,
        /*
         * Where it stands when the motion is off. Without this the whole
         * fleet parks on the origin, because the only position any of them
         * has of its own is the corner of the box.
         */
        rest: { x: w * (0.08 + (i / CARRIES) * 0.84), y: LANE },
        m: markets[i % markets.length],
      }))
    : [];

  /*
   * Proportional, so the road is not a hairline on a monitor or a band on a
   * laptop. The floor keeps it a road at phone widths.
   */
  const thick = Math.max(14, w * 0.016);
  const logo = Math.round(thick * FIT);

  return (
    <div ref={box} aria-hidden
      className={`pointer-events-none absolute left-1/2 top-1/2 h-[380px] w-screen
                  -translate-x-1/2 -translate-y-1/2 ${className}`}>
      {w > 0 && (
        <svg viewBox={`0 0 ${w} ${H}`} className="h-full w-full">
          <defs>
            {/*
             * The sheen runs across the road's thickness rather than down the
             * box, which is why it is pinned to the lane in user space: a
             * gradient over the whole height would leave every horizontal run
             * one flat colour, which is the part that reads as printed.
             */}
            <linearGradient id="road" gradientUnits="userSpaceOnUse"
              x1="0" y1={LANE - thick / 2} x2="0" y2={LANE + thick / 2}>
              {/* Tokens, not hexes: this is the one graphic whose colour is
                  painted rather than inherited, so a pale road on a pale page
                  would simply disappear. */}
              <stop offset="0" stopColor="var(--color-road-1)" />
              <stop offset="0.45" stopColor="var(--color-road-2)" />
              <stop offset="1" stopColor="var(--color-road-3)" />
            </linearGradient>
            {/* Both ends fade out instead of being cut off by the edge, which
                is what makes the road read as continuing past the page. */}
            <linearGradient id="road-fade" x1="0" x2="1">
              <stop offset="0" stopColor="#fff" stopOpacity="0" />
              <stop offset="0.1" stopColor="#fff" stopOpacity="1" />
              <stop offset="0.9" stopColor="#fff" stopOpacity="1" />
              <stop offset="1" stopColor="#fff" stopOpacity="0" />
            </linearGradient>
            <mask id="road-mask">
              <rect x="0" y="0" width={w} height={H} fill="url(#road-fade)" />
            </mask>
            {/* The slip roads run off the bottom of the box, where the
                section's own edge would otherwise cut them square. Only the
                bottom fades: the branches arrive along the top and have to
                stay solid. */}
            <linearGradient id="road-fade-y" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#fff" stopOpacity="1" />
              <stop offset="0.78" stopColor="#fff" stopOpacity="1" />
              <stop offset="1" stopColor="#fff" stopOpacity="0" />
            </linearGradient>
            <mask id="road-mask-y">
              <rect x="0" y="0" width={w} height={H} fill="url(#road-fade-y)" />
            </mask>
          </defs>

          {/* Two masks, nested, because one element takes one mask and the
              road has to fade at four edges. */}
          <g mask="url(#road-mask)">
            <g fill="none" stroke="url(#road)" strokeWidth={thick}
              strokeLinecap="round" mask="url(#road-mask-y)">
              {/* The journey carries the bends and the middle of the lane;
                  these two are the stretches of lane outside the turns, which
                  nothing drives on. */}
              <path id={`${uid}-journey`} d={journey(w)} />
              <path d={`M 0 ${LANE} H ${w * TURN}`} />
              <path d={`M ${w * (1 - TURN)} ${LANE} H ${w}`} />
              <path d={slip(w, 1)} />
              <path d={slip(w, -1)} />
            </g>
          </g>

          {/*
           * The traffic rides inside the drawing rather than being positioned
           * over it, so it is moved by exactly the transform the road is, and
           * it is masked by the same fade so a logo dissolves at the edge with
           * the tarmac instead of sailing on over nothing.
           *
           * `foreignObject` because one of these is the same component the
           * table draws; the alternative is a second way of finding a market's
           * artwork, with its own fallbacks to keep in step.
           */}
          <g mask="url(#road-mask)">
            {traffic.map(({ delay, rest, m }, i) => (
              /*
               * The motion animates this group, not the foreignObject inside
               * it. An animation element placed inside a foreignObject is in
               * the HTML namespace, where it is just an unknown tag that does
               * nothing at all, so the logo would sit at the origin forever.
               */
              <g key={`${m.symbol}-${i}`}
                transform={still ? `translate(${rest.x} ${rest.y})` : undefined}>
                <foreignObject x={-logo / 2} y={-logo / 2} width={logo} height={logo}>
                  {/* The spin is its own animation rather than the motion's
                      `rotate`, which only turns a thing to face along the
                      path -- that would tip every logo on its side through
                      the bends and leave it upright everywhere else. */}
                  <div className={still ? "" : "animate-[spin_4s_linear_infinite]"}>
                    <TickerLogo m={m} size={logo} />
                  </div>
                </foreignObject>
                {!still && (
                  <animateMotion dur={`${SECONDS}s`} begin={`${delay}s`}
                    repeatCount="indefinite" rotate="0">
                    <mpath href={`#${uid}-journey`} />
                  </animateMotion>
                )}
              </g>
            ))}
          </g>
        </svg>
      )}
    </div>
  );
}
