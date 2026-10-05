"use client";

import { type RefObject, useEffect, useRef } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Keyboard focus for a modal: on open it moves into the dialog (to `initial`
 * when given, else the first control), Tab and Shift+Tab cycle inside it,
 * Escape calls `onEscape`, and on close focus goes back to whatever opened it.
 * The page behind stops scrolling while it is open.
 */
export function useModalFocus(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  onEscape: () => void,
  initial?: RefObject<HTMLElement | null>,
) {
  // Read through a ref so a new callback each render does not reopen the trap
  // and steal focus back to the first control.
  const escape = useRef(onEscape);
  escape.current = onEscape;

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusables = () =>
      Array.from(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    const raf = requestAnimationFrame(() =>
      (initial?.current ?? focusables()[0] ?? ref.current)?.focus());

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return escape.current();
      if (e.key !== "Tab") return;
      const f = focusables();
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      const inside = ref.current?.contains(document.activeElement);
      if (e.shiftKey && (document.activeElement === first || !inside)) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
        e.preventDefault(); first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(raf);
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
      opener?.focus?.();
    };
  }, [open, ref, initial]);
}
