import { useMemo } from "react";
import { CommandPalette, type CommandItem } from "@/components/motion/command-palette";
import type { Market } from "@/lib/api";
import { pct } from "@/lib/format";

const GROUP: Record<string, string> = {
  AAPLx: "Equities", NVDAx: "Equities", TSLAx: "Equities", SPYx: "ETFs",
};

/// beUI's command palette, fed the market list. It already owns search,
/// grouping, arrow-key navigation and the ⌘K shortcut, which is the whole
/// reason for reaching for it instead of rebuilding a picker.
export function MarketPalette({
  markets, open, onOpenChange, onSelect,
}: {
  markets: Market[];
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSelect: (symbol: string) => void;
}) {
  const items = useMemo<CommandItem[]>(
    () =>
      [...markets]
        .sort((a, b) => b.volume24h - a.volume24h || b.oi - a.oi)
        .map((m) => ({
          id: m.symbol,
          label: `${m.symbol}-USDC`,
          group: GROUP[m.symbol] ?? "Markets",
          keywords: [m.name, m.symbol],
          hint: `${m.price.toFixed(2)}  ${pct(m.changePct)}`,
          badge: (
            <span className="rounded bg-brand/15 px-1.5 py-px text-[11px] font-semibold text-[#79a5ff]">
              {m.maxLeverage}x
            </span>
          ),
          onSelect: () => onSelect(m.symbol),
        })),
    [markets, onSelect]
  );

  return (
    <CommandPalette
      items={items}
      open={open}
      onOpenChange={onOpenChange}
      placeholder="Search markets"
      emptyMessage="No markets match"
    />
  );
}
