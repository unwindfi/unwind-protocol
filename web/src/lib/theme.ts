/*
 * Which theme the page is in, and how to change it.
 *
 * The document element is the store. `data-theme` is written before first
 * paint by the boot script in index.html and read back here, rather than this
 * module holding a copy in React state: a copy would have to be seeded from
 * storage during render, which is the second guess that produces a flash of
 * the wrong theme when the two disagree.
 *
 * Nothing subscribes to the OS setting. The palette is a dark one by design,
 * and a trading screen that turns itself white because someone's laptop
 * switched at sunset is a surprise, not a courtesy. An explicit choice made
 * here is remembered; without one the page is dark.
 */
import { useCallback, useSyncExternalStore } from "react";

export type Theme = "dark" | "light";

const KEY = "unwind.theme";

/// Page colours the browser paints its own chrome with -- the iOS status bar
/// and the Android address bar. They read the tag once and do not watch it,
/// so it is set again on every change.
const CHROME: Record<Theme, string> = { dark: "#0c0a1c", light: "#f6f7fb" };

const listeners = new Set<() => void>();

const read = (): Theme =>
  document.documentElement.dataset.theme === "light" ? "light" : "dark";

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
};

export function setTheme(next: Theme) {
  document.documentElement.dataset.theme = next;
  // Refused outright in some browsers, and it throws rather than returning
  // nothing, so the choice has to survive not being saved.
  try { localStorage.setItem(KEY, next); } catch { /* private window */ }
  document.querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", CHROME[next]);
  for (const fn of listeners) fn();
}

/// The current theme, and the one thing anyone does with it.
export function useTheme() {
  const theme = useSyncExternalStore(subscribe, read, () => "dark" as Theme);
  const toggle = useCallback(() => setTheme(read() === "dark" ? "light" : "dark"), []);
  return { theme, toggle };
}
