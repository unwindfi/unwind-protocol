import { AnimatePresence, motion, type PanInfo } from "motion/react";
import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";
import { TOUCH_GESTURE_CLASS } from "@/lib/touch";

/*
 * A bottom sheet, for the panels that are a side column on desktop.
 *
 * Dragging is the reason this is not a plain modal: on a phone the order ticket
 * is reached with a thumb at the bottom of the screen, and a sheet you can only
 * dismiss by hitting a small X in the far corner is a sheet you fight. The drag
 * is committed on velocity as well as distance, so a quick flick closes it
 * without having to pull the whole panel off screen.
 */
const CLOSE_PX = 90;
const CLOSE_VELOCITY = 500;

export function Sheet({
  open, onOpenChange, title, children,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  children: ReactNode;
}) {
  // The sheet scrolls its own content; the page behind it must not scroll with
  // it, or dismissing leaves the trader somewhere else in the layout.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onOpenChange(false); };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onOpenChange]);

  const onDragEnd = (_: unknown, info: PanInfo) => {
    if (info.offset.y > CLOSE_PX || info.velocity.y > CLOSE_VELOCITY) onOpenChange(false);
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            className="fixed inset-0 z-40 bg-black/60"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            onClick={() => onOpenChange(false)} />

          <motion.div
            role="dialog" aria-modal="true" aria-label={title}
            className="fixed inset-x-0 bottom-0 z-50 flex max-h-[88dvh] flex-col
                       rounded-t-[24px] border-t border-line bg-panel"
            initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
            transition={{ type: "spring", stiffness: 420, damping: 38 }}
            drag="y"
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.4 }}
            onDragEnd={onDragEnd}>

            <div className={`flex flex-none items-center gap-2 px-4 pb-1 pt-2 ${TOUCH_GESTURE_CLASS}`}>
              <div className="absolute left-1/2 top-2 h-1 w-9 -translate-x-1/2
                              rounded-full bg-panel3" />
              <span className="mt-2 text-[14px] font-medium">{title}</span>
              <button onClick={() => onOpenChange(false)} aria-label="Close"
                className="ml-auto mt-2 grid size-9 place-items-center rounded-full
                           text-muted-foreground transition-colors hover:text-foreground
                           active:bg-panel3">
                <X size={17} />
              </button>
            </div>

            <div className="pane-scroll min-h-0 flex-1 safe-b">{children}</div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
