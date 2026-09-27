/*
 * The theme switch.
 *
 * One control with two states rather than a menu of three: there is no
 * "system" here to follow (see `lib/theme`), so a menu would be a dropdown
 * over a single choice.
 *
 * The glyph shows the theme you would get, not the one you are in. A sun on a
 * dark page reads as "make it light", which is what pressing it does; drawing
 * the current state instead makes the button a label you have to think about
 * before you can use it.
 */
import { Moon, Sun } from "lucide-react";
import { useTheme } from "@/lib/theme";

export function ThemeToggle({ className = "" }: { className?: string }) {
  const { theme, toggle } = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button type="button" onClick={toggle}
      // The label says what the press does. `aria-pressed` would say the
      // button is "on", which is meaningless for a switch between two peers.
      aria-label={`Switch to ${next} theme`} title={`Switch to ${next} theme`}
      className={`press flex flex-none items-center justify-center rounded-[10px] border
                  border-line bg-panel2 text-muted-foreground transition-colors
                  hover:border-brand hover:text-foreground ${className}`}>
      {theme === "dark"
        ? <Sun size={16} strokeWidth={1.75} />
        : <Moon size={16} strokeWidth={1.75} />}
    </button>
  );
}
