"use client";
// beui.dev/components/motion/number

import { animate, useInView, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { EASE_OUT } from "@/lib/ease";
import { cn } from "@/lib/utils";

export interface AnimatedNumberProps {
  value: number;
  duration?: number;
  format?: (n: number) => string;
  className?: string;
  startOnView?: boolean;
}

export function AnimatedNumber({
  value,
  duration = 1.2,
  format = (n) => Math.round(n).toLocaleString(),
  className,
  startOnView = true,
}: AnimatedNumberProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.6 });
  const reduce = useReducedMotion();
  const [display, setDisplay] = useState(0);
  // What is on screen now, so a value that lands mid-count carries on from
  // there instead of jumping back to the last target.
  const fromRef = useRef(0);
  // The first count is an entrance and takes its time; a live figure moving
  // after that should settle quickly.
  const entered = useRef(false);

  useEffect(() => {
    if (startOnView && !inView) return;
    if (reduce) {
      fromRef.current = value;
      setDisplay(value);
      return;
    }
    const controls = animate(fromRef.current, value, {
      duration: entered.current ? Math.min(duration, 0.4) : duration,
      ease: EASE_OUT,
      onUpdate: (v) => { fromRef.current = v; setDisplay(v); },
    });
    entered.current = true;
    return () => controls.stop();
  }, [value, duration, inView, startOnView, reduce]);

  return (
    // The figure counts up once it scrolls into view, so until then the
    // visible digits read zero; screen readers and copied text get the
    // real value instead.
    <span ref={ref} className={cn("tabular-nums", className)}>
      <span aria-hidden="true">{format(display)}</span>
      <span className="sr-only">{format(value)}</span>
    </span>
  );
}
