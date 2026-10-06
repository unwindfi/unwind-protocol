/*
 * A figure that could not be read, as against one that reads zero. Muted,
 * with a way to read again, so a failed fetch never passes for $0.
 */
export function Unavailable({ onRetry }: { onRetry?: () => void }) {
  return (
    <span className="inline-flex items-baseline gap-2 font-normal text-muted-foreground">
      Unavailable
      {onRetry && (
        <button type="button" onClick={onRetry}
          className="font-medium text-foreground underline decoration-line underline-offset-4 hover:decoration-foreground">
          Retry
        </button>
      )}
    </span>
  );
}

/// Still reading: a muted placeholder, not a number.
export const Pending = () => <span className="font-normal text-dim" aria-label="Loading">--</span>;
