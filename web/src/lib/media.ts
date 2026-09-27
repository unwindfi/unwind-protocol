import { useEffect, useState } from "react";

/// Tracks a media query from React.
///
/// The mobile layout is a different component tree, not the desktop one with
/// things hidden: the panes become tabs and the order ticket becomes a sheet.
/// CSS alone cannot express that, and hiding the chart with `display:none`
/// would leave Lightweight Charts auto-sizing against a zero-height box and
/// render an empty pane when it came back.
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches
  );
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatches(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return matches;
}

/// Below this the three-column trading layout stops fitting: chart, tape and
/// ticket cannot all hold a readable width, so the panes become tabs instead.
export const MOBILE_QUERY = "(max-width: 767px)";

export const useIsMobile = () => useMediaQuery(MOBILE_QUERY);
