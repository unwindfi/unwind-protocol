import type { ReactNode } from "react";
import {
  Tabs as BeTabs, TabsContent, TabsList as BeTabsList, TabsTrigger as BeTabsTrigger,
} from "@/components/motion/tabs";
import { cn } from "@/lib/utils";
import { PILL_INDICATOR, PILL_LIST, PILL_TRIGGER } from "@/site/Chrome";

/*
 * beUI's tabs, in the house pill look.
 *
 * The classes are the site's own (`PILL_*` in Chrome), so every tab row on
 * /trade is the same control as the ones on /list and /earn: no track, and
 * the selected tab an inverted pill that slides between the options. Wrapped
 * once so the rows on this page cannot drift apart.
 */
export function Tabs({
  value, defaultValue, onValueChange, children, className,
}: {
  value?: string; defaultValue?: string; onValueChange?: (v: string) => void;
  children: ReactNode; className?: string;
}) {
  return (
    <BeTabs variant="pill" value={value} defaultValue={defaultValue}
      onValueChange={onValueChange} className={className}>
      {children}
    </BeTabs>
  );
}

/*
 * `soft` is the quiet row: a tinted track with the selected option a lighter
 * chip inside it, rather than an inverted pill. For controls that sit beside
 * data (the chart's timeframes) and should not outshout it.
 */
const SOFT_LIST = "rounded-full bg-panel2 p-1 gap-0.5";
const SOFT_TRIGGER =
  "h-8 px-3.5 text-[13px] font-normal [&_[data-tabs-label]]:font-medium " +
  "[&_[data-tabs-label]]:text-foreground";
const SOFT_INDICATOR = "bg-panel3";

export function TabsList({ children, className, soft = false }: {
  children: ReactNode; className?: string; soft?: boolean;
}) {
  return (
    <BeTabsList className={cn(soft ? SOFT_LIST : cn(PILL_LIST, "gap-1"), className)}>
      {children}
    </BeTabsList>
  );
}

/// `className` sizes a row that needs it (the ticket's full-width side
/// switch, the book's narrow column); the look itself stays the shared one.
export function TabsTrigger({ value, children, className, soft = false }: {
  value: string; children: ReactNode; className?: string; soft?: boolean;
}) {
  return (
    <BeTabsTrigger value={value} className={cn(soft ? SOFT_TRIGGER : PILL_TRIGGER, className)}
      indicatorClassName={soft ? SOFT_INDICATOR : PILL_INDICATOR}>
      {children}
    </BeTabsTrigger>
  );
}

export { TabsContent };
