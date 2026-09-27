import { PAY_TOKENS, type PayWith } from "@/lib/listing";

/// A token backing can be paid in, as its logo and ticker. Inline, so it can
/// sit inside a sentence as easily as on a button; the logo is decorative
/// and the ticker beside it is what a screen reader hears.
export function PayToken({ k, size = 16, className = "" }: {
  k: PayWith; size?: number; className?: string;
}) {
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap align-[-0.2em] ${className}`}>
      <img src={PAY_TOKENS[k].logo} alt="" width={size} height={size} decoding="async"
        className="flex-none rounded-full" style={{ width: size, height: size }} />
      <span>{k}</span>
    </span>
  );
}
