import {
  AnimatePresence, motion, useDragControls, useReducedMotion, type PanInfo,
} from "motion/react";
import { useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { TOUCH_GESTURE_CLASS } from "@/lib/touch";
import { useModalFocus } from "@/lib/hooks/use-modal-focus";
import { DUR } from "@/lib/ease";

/*
 * A bottom sheet, for the panels that are a side column on desktop.
 *
 * Dragging is the reason this is not a plain modal: on a phone the order ticket
 * is reached with a thumb at the bottom of the screen, and a sheet you can only
 * dismiss by hitting a small X in the far corner is a sheet you fight. The drag
 * is committed on velocity as well as distance, so a quick flick closes it
 * without having to pull the whole panel off screen.
 *
 * Only the header strip starts a drag. On the whole sheet, a swipe inside the
 * ticket would move the sheet instead of scrolling the ticket.
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
  const reduce = useReducedMotion() ?? false;
  const drag = useDragControls();
  const panel = useRef<HTMLDivElement>(null);

  // The page behind stops scrolling, focus moves in and stays in, and
  // closing hands focus back to the button that opened it.
  useModalFocus(panel, open, () => onOpenChange(false));

  // A pull past the line or a downward flick closes; a pull that is heading
  // back up when released stays open, however far it went.
  const onDragEnd = (_: unknown, info: PanInfo) => {
    if (info.velocity.y < -100) return;
    if (info.offset.y > CLOSE_PX || info.velocity.y > CLOSE_VELOCITY) onOpenChange(false);
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            className="fixed inset-0 z-40 bg-black/60"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: DUR.moderate }}
            onClick={() => onOpenChange(false)} />

          <motion.div
            role="dialog" aria-modal="true" aria-label={title}
            className="fixed inset-x-0 bottom-0 z-50 flex max-h-[88dvh] flex-col
                       rounded-t-[24px] border-t border-line bg-panel outline-none"
            ref={panel} tabIndex={-1}
            {...(reduce
              ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 },
                  transition: { duration: DUR.moderate } }
              : { initial: { y: "100%" }, animate: { y: 0 }, exit: { y: "100%" },
                  transition: { type: "spring" as const, stiffness: 420, damping: 38 } })}
            drag={reduce ? false : "y"}
            dragListener={false}
            dragControls={drag}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.4 }}
            dragTransition={{ bounceStiffness: 500, bounceDamping: 40 }}
            onDragEnd={onDragEnd}>

            <div onPointerDown={(e) => drag.start(e)}
              className={`flex flex-none touch-none items-center gap-2 px-4 pb-1 pt-2 outline-none ${TOUCH_GESTURE_CLASS}`}>
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
