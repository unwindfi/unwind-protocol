import type { ReactNode } from "react";

/*
 * The one container this page is built out of.
 *
 * The terminal drew its structure with full-bleed rules: panes divided by
 * single lines, every edge shared with a neighbour. A page that scrolls has
 * no such frame to hang lines on, so the sections have to be objects with
 * edges of their own -- and once they are objects, one definition of what an
 * object looks like is what keeps six of them from being six slightly
 * different cards.
 */
/*
 * The navbar's panel, for the page under it: flush with its neighbours, a
 * 2px seam of page between them, small rounded corners and one bottom rule.
 * The seam flares into a curve where corners meet, so the page reads as the
 * same set of parts as the bar above it rather than cards floated on a tray.
 */
export const PANEL = "rounded-[14px] border-b border-line bg-panel";

export function Box({ title, aside, children, className = "", bodyClassName = "" }: {
  title?: ReactNode;
  /// The controls that belong to this box, on the right of its header.
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={`overflow-hidden ${PANEL} ${className}`}>
      {(title || aside) && (
        /* A plain heading over a rule, the way /list titles its card. The
           tinted band and small caps it used to wear made every box read as
           a table header rather than as a section of the page. */
        <header className="flex flex-none items-center justify-between gap-3 border-b
                           border-line px-6 py-4">
          {/* A heading even when it is only read by a screen reader: these
              boxes are the page's structure, and structure that exists only
              visually is structure half the visitors do not get. */}
          <h2 className="text-[13.5px] font-medium text-foreground">
            {title}
          </h2>
          {aside}
        </header>
      )}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

/// Caption over figure. The page's only way of stating a number.
export function Tile({ label, children, tone = "" }: {
  label: string; children: ReactNode; tone?: string;
}) {
  return (
    <div className="rounded-[14px] border border-line bg-panel px-5 py-5">
      <div className="text-[13px] text-muted-foreground">{label}</div>
      <div className={`n mt-4 truncate text-[20px] font-medium tracking-[-.01em] ${tone}`}>
        {children}
      </div>
    </div>
  );
}
