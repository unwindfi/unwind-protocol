import { createContext, useContext, type ReactNode } from "react";
import {
  Tabs as BeTabs, TabsContent, TabsList as BeTabsList, TabsTrigger as BeTabsTrigger,
} from "@/components/motion/tabs";
import { cn } from "@/lib/utils";

/*
 * beUI's tabs, in two looks.
 *
 * `line` is how the trade screen's tab rows read: plain 12px text on one
 * hairline, the selected tab brighter with a 2px violet underline that
 * slides to it, as a trading terminal's do. The rounded chips made those
 * rows look like a template.
 *
 * Without it, a soft track with the chosen option a lighter chip that slides
 * between them, for choices rather than places: the chart's timeframes, the
 * ticket's side. Never an inverted pill: on a screen of figures a white chip
 * is the loudest thing on it.
 */
const Line = createContext(false);

export function Tabs({
  value, defaultValue, onValueChange, children, className, line = false,
}: {
  value?: string; defaultValue?: string; onValueChange?: (v: string) => void;
  children: ReactNode; className?: string; line?: boolean;
}) {
  return (
    <Line.Provider value={line}>
      <BeTabs variant={line ? "underline" : "pill"} value={value} defaultValue={defaultValue}
        onValueChange={onValueChange} className={className}>
        {children}
      </BeTabs>
    </Line.Provider>
  );
}

const SOFT_LIST = "rounded-full bg-panel2 p-1 gap-0.5";
const SOFT_TRIGGER =
  "h-8 px-3.5 text-[13px] font-normal [&_[data-tabs-label]]:font-medium " +
  "[&_[data-tabs-label]]:text-foreground";
const SOFT_INDICATOR = "bg-panel3";

const LINE_LIST = "gap-1 border-line";
const LINE_TRIGGER = "min-h-0 h-9 px-2.5 py-0 text-[12px] font-normal";
const LINE_INDICATOR = "bottom-[-1px] h-[2px] rounded-full bg-tab";

export function TabsList({ children, className }: {
  children: ReactNode; className?: string; soft?: boolean;
}) {
  const line = useContext(Line);
  return (
    <BeTabsList className={cn(line ? LINE_LIST : SOFT_LIST, className)}>
      {children}
    </BeTabsList>
  );
}

/// `className` sizes a row that needs it (the ticket's full-width side
/// switch, the book's narrow column); the look itself stays the shared one.
export function TabsTrigger({ value, children, className }: {
  value: string; children: ReactNode; className?: string; soft?: boolean;
}) {
  const line = useContext(Line);
  return (
    <BeTabsTrigger value={value} className={cn(line ? LINE_TRIGGER : SOFT_TRIGGER, className)}
      indicatorClassName={line ? LINE_INDICATOR : SOFT_INDICATOR}>
      {children}
    </BeTabsTrigger>
  );
}

export { TabsContent };
