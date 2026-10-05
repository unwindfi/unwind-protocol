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
import { AnimatePresence, motion } from "motion/react";
import { useTheme } from "@/lib/theme";

// The glyphs cross-fade rather than swap: scale, opacity and blur together,
// a spring with no bounce.
const SWAP = {
  initial: { scale: 0.25, opacity: 0, filter: "blur(4px)" },
  animate: { scale: 1, opacity: 1, filter: "blur(0px)" },
  exit: { scale: 0.25, opacity: 0, filter: "blur(4px)" },
  transition: { type: "spring" as const, duration: 0.3, bounce: 0 },
};

export function ThemeToggle({ className = "" }: { className?: string }) {
  const { theme, toggle } = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button type="button" onClick={toggle}
      // The label says what the press does. `aria-pressed` would say the
      // button is "on", which is meaningless for a switch between two peers.
      aria-label={`Switch to ${next} theme`} title={`Switch to ${next} theme`}
      className={`press relative flex flex-none items-center justify-center rounded-[12px]
                  text-muted-foreground hover:bg-panel2 hover:text-foreground ${className}`}>
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span key={theme} {...SWAP} className="flex">
          {theme === "dark"
            ? <Sun size={19} strokeWidth={1.75} />
            : <Moon size={19} strokeWidth={1.75} />}
        </motion.span>
      </AnimatePresence>
    </button>
  );
}
