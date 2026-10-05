"use client";

import { motion, useReducedMotion, type Variants } from "motion/react";
import { useMemo, type ComponentProps, type ReactNode, type Ref } from "react";
import { EASE_OUT } from "@/lib/ease";
import { cn } from "@/lib/utils";

type Side = "top" | "right" | "bottom" | "left";

// Offset is in the direction *away* from the trigger — content originates near
// the trigger and settles into resting position.
const offsetFrom: Record<Side, { x?: number; y?: number }> = {
  top: { y: 4 },
  bottom: { y: -4 },
  left: { x: 4 },
  right: { x: -4 },
};

// A tooltip is read, not watched: a short ease-out tween with a barely
// visible scale. No blur and no spring, so it is legible from the first frame.
function buildVariants(side: Side): Variants {
  const o = offsetFrom[side];
  return {
    initial: { opacity: 0, scale: 0.97, x: o.x ?? 0, y: o.y ?? 0 },
    animate: {
      opacity: 1,
      scale: 1,
      x: 0,
      y: 0,
      transition: { duration: 0.125, ease: EASE_OUT },
    },
    exit: {
      opacity: 0,
      scale: 0.97,
      transition: { duration: 0.1, ease: EASE_OUT },
    },
  };
}

const REDUCED_VARIANTS: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.14, ease: EASE_OUT } },
  exit: { opacity: 0, transition: { duration: 0.1, ease: EASE_OUT } },
};

/** The shared visual surface for trigger tooltips and chart readouts. Positioning belongs to the caller. */
export function TooltipSurface({
  children,
  side = "top",
  instant = false,
  className,
  ref,
  ...props
}: Omit<ComponentProps<typeof motion.span>, "children"> & {
  children?: ReactNode;
  side?: Side;
  /** Skip the entrance, for a tooltip opened while a neighbour just closed. */
  instant?: boolean;
  ref?: Ref<HTMLSpanElement>;
}) {
  const reduce = useReducedMotion();
  const variants = useMemo(() => reduce ? REDUCED_VARIANTS : buildVariants(side), [reduce, side]);
  return (
    <motion.span
      ref={ref}
      role="tooltip"
      variants={variants}
      initial={instant ? false : "initial"}
      animate="animate"
      exit="exit"
      className={cn(
        "block whitespace-nowrap rounded-lg border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground shadow-lg",
        className,
      )}
      {...props}
    >
      {children}
    </motion.span>
  );
}
