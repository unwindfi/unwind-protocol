"use client";
// beui.dev/components/motion/range-slider

import {
  motion,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
} from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { EASE_OUT, SPRING_GLIDE } from "@/lib/ease";
import { type SliderOptions, useSlider } from "@/lib/hooks/use-slider";
import { TOUCH_GESTURE_CLASS } from "@/lib/touch";
import { cn } from "@/lib/utils";

// Grab feedback: a quick, flat ease. A bounce here wobbles under the finger.
const GRAB = { duration: 0.12, ease: EASE_OUT } as const;

export interface RangeSliderProps extends SliderOptions {
  /** Render a tick dot at each step. */
  showTicks?: boolean;
  className?: string;
}

export function RangeSlider({ showTicks = true, className, ...options }: RangeSliderProps) {
  const reduce = useReducedMotion();
  const { percent, dragging, min, max, step, trackProps, sliderProps } = useSlider(options);
  const [trackWidth, setTrackWidth] = useState(292);
  useLayoutEffect(() => {
    const track = trackProps.ref.current;
    if (!track) return;
    const measure = () => {
      const width = track.getBoundingClientRect().width;
      if (width > 0) setTrackWidth(width);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(track);
    return () => observer.disconnect();
  }, [trackProps.ref]);

  // Spring-smoothed position drives both the thumb and the fill. The spring is
  // for jumps (a click on the rail, an arrow key); once a drag is under way the
  // thumb sits exactly under the pointer, or it trails the finger.
  const target = useMotionValue(percent);
  const smooth = useSpring(target, SPRING_GLIDE);
  const wasDragging = useRef(false);
  useEffect(() => {
    target.set(percent);
    if (dragging && wasDragging.current) smooth.jump(percent);
    wasDragging.current = dragging;
  }, [percent, dragging, target, smooth]);
  const pos = reduce ? target : smooth;
  const thumbX = useTransform(pos, (p) => 8 + Math.max(0, trackWidth - 20) * p / 100);
  // Match InlineSlider: the 4px handle starts 8px inside the track, and
  // the rounded fill extends 8px past its left edge. Translate a full-size
  // fill inside the 2px inset clip so its corner never stretches.
  const fillX = useTransform(pos, (p) => p >= 100
    ? "0%"
    : `calc(${p - 100}% + ${14 - 0.16 * p}px)`);

  // Floor rather than round, so a range the step does not divide (0 to 10 by 4)
  // stops its dots at the last whole step instead of drawing one past max.
  // toFixed comes first because 0.3/0.1 is 2.9999999999999996, which would
  // floor to 2 and drop the last dot.
  const steps = Math.floor(Number(((max - min) / step).toFixed(6)));
  const ticks =
    showTicks && steps > 0 && steps <= 50
      ? Array.from({ length: steps + 1 }, (_, i) => Number((min + i * step).toFixed(6)))
      : [];

  return (
    <div
      {...trackProps}
      className={cn(
        "relative flex h-8 w-full touch-none items-center",
        TOUCH_GESTURE_CLASS,
        options.disabled
          ? "pointer-events-none opacity-35"
          : "cursor-grab active:cursor-grabbing",
        className,
      )}
    >
      {/* A thin rail, filled up to the thumb. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-[2px] top-1/2 h-1 -translate-y-1/2
                                         overflow-hidden rounded-full bg-panel3">
        <motion.div className="absolute inset-0 rounded-full bg-foreground/70" style={{ x: fillX }} />
      </div>

      {/* Tick centres follow the same inset path as the handle centre. */}
      <div className="pointer-events-none absolute inset-x-[10px] inset-y-0">
        {ticks.map((t) => {
          const tp = ((t - min) / (max - min)) * 100;
          return (
            <span
              key={t}
              className="absolute top-1/2 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground/30"
              style={{ left: `${tp}%` }}
            />
          );
        })}
      </div>

      {/* Keep the handle inside the rounded progress fill at both ends. */}
      <motion.div
        {...sliderProps}
        animate={reduce ? undefined : { scale: dragging ? 1.15 : 1 }}
        transition={GRAB}
        className="absolute left-0 top-1/2 -ml-2 size-4 rounded-full bg-foreground shadow-[0_1px_4px_rgba(0,0,0,.35)]
                   outline-none ring-foreground/25 focus-visible:ring-4"
        style={{ x: thumbX, y: "-50%" }}
      />
    </div>
  );
}
