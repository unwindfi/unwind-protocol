/** The one ease-out. CSS uses the same curve as `--ease-out-strong` in
 * index.css (Tailwind: `ease-out-strong`); change both together. */
export const EASE_OUT = [0.23, 1, 0.32, 1] as const;
export const EASE_IN_OUT = [0.77, 0, 0.175, 1] as const;
export const EASE_DRAWER = [0.32, 0.72, 0, 1] as const;

/** Durations in seconds, for motion. The same scale is `--duration-*` in
 * index.css (Tailwind: `duration-fast` and so on); change both together.
 *   fast      tooltips, icon and label swaps, small reveals
 *   base      hover, press, every colour change
 *   moderate  sheets, menus, toasts, panels opening
 *   slow      theme swap and page-level reveals */
export const DUR = {
  fast: 0.12,
  base: 0.15,
  moderate: 0.2,
  slow: 0.3,
} as const;

/** EASE_OUT for inline style transitions. */
export const EASE_OUT_CSS = "var(--ease-out-strong)";

/** Press feedback on buttons and other tappable surfaces. */
export const SPRING_PRESS = {
  type: "spring",
  stiffness: 500,
  damping: 30,
  mass: 0.6,
} as const;

/** Content swaps — label/icon slots trading places inside a control. */
export const SPRING_SWAP = {
  type: "spring",
  stiffness: 460,
  damping: 30,
  mass: 0.55,
} as const;

/** Overlay panel entrances — modals and sheets summoned by pointer. */
export const SPRING_PANEL = {
  type: "spring",
  stiffness: 420,
  damping: 40,
  mass: 0.5,
} as const;

/** Shared-layout glides — pills, indicators and panels morphing between positions. */
export const SPRING_LAYOUT = {
  type: "spring",
  stiffness: 360,
  damping: 32,
  mass: 0.6,
} as const;

/** Cursor-follow physics for decorative mouse tracking (magnetic, tilt, dock). */
export const SPRING_MOUSE = {
  stiffness: 200,
  damping: 15,
  mass: 0.3,
} as const;

/** Dragged handles and fills (sliders) — critically damped `useSpring` config,
 * so the value follows the pointer butterily and never rebounds off an end. */
export const SPRING_GLIDE = {
  stiffness: 700,
  damping: 50,
  mass: 0.5,
} as const;
