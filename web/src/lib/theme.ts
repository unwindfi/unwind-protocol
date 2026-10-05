/*
 * Which theme the page is in, and how to change it.
 *
 * The document element is the store. `data-theme` is written before first
 * paint by the boot script in index.html and read back here, rather than this
 * module holding a copy in React state: a copy would have to be seeded from
 * storage during render, which is the second guess that produces a flash of
 * the wrong theme when the two disagree.
 *
 * Three choices: light, dark, or the system's. "System" follows the OS and
 * keeps following it; an explicit light or dark does not. Without a choice
 * the page is light.
 */
import { useCallback, useSyncExternalStore } from "react";

export type Theme = "dark" | "light";
export type Choice = Theme | "system";

const KEY = "unwind.theme";

/// Page colours the browser paints its own chrome with -- the iOS status bar
/// and the Android address bar. They read the tag once and do not watch it,
/// so it is set again on every change.
const CHROME: Record<Theme, string> = { dark: "#0e1012", light: "#e4eaee" };

const listeners = new Set<() => void>();

const media = () => (typeof window !== "undefined" && window.matchMedia
  ? window.matchMedia("(prefers-color-scheme: dark)") : null);

const read = (): Theme =>
  document.documentElement.dataset.theme === "dark" ? "dark" : "light";

export const readChoice = (): Choice => {
  try {
    const v = localStorage.getItem(KEY);
    return v === "dark" || v === "light" || v === "system" ? v : "light";
  } catch { return "light"; }
};

const resolve = (c: Choice): Theme => (c === "system" ? (media()?.matches ? "dark" : "light") : c);

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
};

function apply(next: Theme) {
  // Nearly every element transitions its colours, so a theme flip would fire
  // them all at once and smear the page. Switch with transitions off, force a
  // reflow, and hand them back on the next frame.
  const still = document.createElement("style");
  still.textContent = "*,*::before,*::after{transition:none !important}";
  document.head.appendChild(still);
  document.documentElement.dataset.theme = next;
  void document.documentElement.offsetHeight;
  requestAnimationFrame(() => still.remove());
  document.querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", CHROME[next]);
  for (const fn of listeners) fn();
}

export function setChoice(c: Choice) {
  // Refused outright in some browsers, and it throws rather than returning
  // nothing, so the choice has to survive not being saved.
  try { localStorage.setItem(KEY, c); } catch { /* private window */ }
  apply(resolve(c));
}

export const setTheme = (next: Theme) => setChoice(next);

// While the choice is "system", the OS switching at sunset switches the page.
media()?.addEventListener?.("change", () => { if (readChoice() === "system") apply(resolve("system")); });

/// The current theme, the choice behind it, and the ways to change them.
export function useTheme() {
  const theme = useSyncExternalStore(subscribe, read, () => "light" as Theme);
  const choice = useSyncExternalStore(subscribe, readChoice, () => "light" as Choice);
  const toggle = useCallback(() => setChoice(read() === "dark" ? "light" : "dark"), []);
  return { theme, choice, toggle, setChoice };
}
