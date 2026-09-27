export const money = (n: number, d = 2) =>
  (n < 0 ? "-" : "") +
  "$" +
  Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });

export const compact = (n: number) =>
  "$" + Math.abs(n).toLocaleString(undefined, { notation: "compact", maximumFractionDigits: 2 });

/// A token price at a precision that suits its magnitude.
///
/// A meme token at $0.0000214 and an equity at $766.15 cannot share a decimal
/// count. Four places is right for one and prints "$0.0000" for the other,
/// which is the single number that price is definitely not.
export const price = (n: number) => {
  if (!Number.isFinite(n) || n <= 0) return "--";
  // Two places from $10 up, where a cent is already fine granularity and a
  // fourth place is just the last trade's noise. Below that, enough places to
  // keep four significant digits, however far down the token sits.
  const d = n >= 10 ? 2 : Math.min(12, 3 - Math.floor(Math.log10(n)));
  return "$" + n.toLocaleString(undefined,
    { minimumFractionDigits: d, maximumFractionDigits: d });
};

export const pct = (n: number) => (n >= 0 ? "+" : "") + n.toFixed(2) + "%";

/// A duration as m:ss, or h:mm:ss past the hour. For countdowns.
export const clock = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${two(mm)}:${two(ss)}` : `${mm}:${two(ss)}`;
};

export const hhmmss = (t: number) => new Date(t).toLocaleTimeString("en-GB");

/// Tailwind class for a signed value: green up, red down, inherit at zero.
export const tone = (n: number) => (n > 0 ? "text-up" : n < 0 ? "text-down" : "");
