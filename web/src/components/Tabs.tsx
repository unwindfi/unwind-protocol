import type { ReactNode } from "react";
import {
  Tabs as BeTabs, TabsContent, TabsList as BeTabsList, TabsTrigger as BeTabsTrigger,
} from "@/components/motion/tabs";
import { cn } from "@/lib/utils";

/*
 * beUI's tabs, as one control everywhere on /trade: a soft track with the
 * chosen option a lighter chip that slides between them, the way /markets
 * picks a sort or a source. Never an inverted pill: on a screen of figures a
 * white chip is the loudest thing on it.
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
    <BeTabsList className={cn(SOFT_LIST, className)}>
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
    <BeTabsTrigger value={value} className={cn(SOFT_TRIGGER, className)}
      indicatorClassName={SOFT_INDICATOR}>
      {children}
    </BeTabsTrigger>
  );
}

export { TabsContent };
