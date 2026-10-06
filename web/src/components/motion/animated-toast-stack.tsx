"use client";
// beui.dev/components/motion/animated-toast-stack

import {
  AlertCircle,
  Check,
  ExternalLink,
  Info,
  LoaderCircle,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  AnimatePresence,
  motion,
  useReducedMotion,
  type Transition,
} from "motion/react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { EASE_OUT } from "@/lib/ease";
import { cn } from "@/lib/utils";

export type ToastStatus = "neutral" | "info" | "loading" | "success" | "error";
export type ToastPosition =
  | "top-left"
  | "top-center"
  | "top-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

export type AnimatedToastAction = {
  label: ReactNode;
  onClick: (toast: AnimatedToast) => void;
};

/// A link under the toast's text. A path on this site is followed in place by
/// the site's router; an outside address opens in a new tab with a small mark.
/// `primary` draws it as a button, for the one next step the toast offers.
export type AnimatedToastLink = {
  label: ReactNode;
  href: string;
  primary?: boolean;
  /// Muted, monospaced text beside the link, such as a short signature.
  aside?: string;
};

export type AnimatedToast = {
  id: string;
  title: ReactNode;
  description?: ReactNode;
  status?: ToastStatus;
  icon?: ReactNode;
  action?: AnimatedToastAction;
  links?: AnimatedToastLink[];
  duration?: number;
  dismissible?: boolean;
  createdAt?: number;
};

export type ToastInput = Omit<AnimatedToast, "id" | "createdAt"> & {
  id?: string;
};

export type ToastClassNames = {
  root?: string;
  item?: string;
  surface?: string;
  iconWrap?: string;
  content?: string;
  title?: string;
  description?: string;
  action?: string;
  close?: string;
  progress?: string;
};

export interface AnimatedToastStackProps {
  toasts: AnimatedToast[];
  onDismiss?: (id: string) => void;
  position?: ToastPosition;
  placement?: "static" | "fixed" | "absolute";
  fixed?: boolean;
  portal?: boolean;
  portalRoot?: Element | null;
  maxVisible?: number;
  className?: string;
  classNames?: ToastClassNames;
  icons?: Partial<Record<ToastStatus, ReactNode>>;
  renderToast?: (toast: AnimatedToast) => ReactNode;
}

export interface UseAnimatedToastStackOptions {
  initialToasts?: ToastInput[];
  defaultDuration?: number;
  limit?: number;
}

const STACK_SPRING: Transition = {
  type: "spring",
  stiffness: 420,
  damping: 34,
  mass: 0.75,
};

const CONTENT_TRANSITION = {
  duration: 0.28,
  ease: EASE_OUT,
} as const;

// A neutral toast is a plain line of text: there is no state to signal.
const STATUS_ICON: Record<ToastStatus, LucideIcon | null> = {
  neutral: null,
  info: Info,
  loading: LoaderCircle,
  success: Check,
  error: AlertCircle,
};

const STATUS_CLASS: Record<ToastStatus, string> = {
  neutral: "text-muted-foreground",
  info: "text-muted-foreground",
  loading: "text-muted-foreground",
  success: "text-up",
  error: "text-down",
};

const POSITION_CLASS: Record<ToastPosition, string> = {
  "top-left": "left-4 top-4",
  "top-center": "left-1/2 top-4 -translate-x-1/2",
  "top-right": "right-4 top-4",
  "bottom-left": "bottom-6 left-4",
  "bottom-center": "bottom-6 left-1/2 -translate-x-1/2",
  "bottom-right": "bottom-6 right-4",
};

let idSeed = 0;

function createToast(input: ToastInput, defaultDuration: number): AnimatedToast {
  return {
    // An error stays until it is dismissed: it is the one toast the reader
    // may need longer than four seconds to act on.
    duration: input.status === "error" ? 0 : defaultDuration,
    dismissible: true,
    ...input,
    id: input.id ?? `toast-${Date.now()}-${idSeed++}`,
    createdAt: Date.now(),
  };
}

export function useAnimatedToastStack({
  initialToasts = [],
  defaultDuration = 4200,
  limit,
}: UseAnimatedToastStackOptions = {}) {
  const toastTimers = useRef<Map<string, { timer: number; signature: string }>>(new Map());
  const [toasts, setToasts] = useState<AnimatedToast[]>(() =>
    initialToasts.map((toast) => createToast(toast, defaultDuration)),
  );

  const dismissToast = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const clearToasts = useCallback(() => {
    setToasts([]);
  }, []);

  const showToast = useCallback(
    (input: ToastInput) => {
      const toast = createToast(input, defaultDuration);
      setToasts((current) => {
        const next = [...current, toast];
        return typeof limit === "number" ? next.slice(-limit) : next;
      });
      return toast.id;
    },
    [defaultDuration, limit],
  );

  const updateToast = useCallback((id: string, patch: Partial<ToastInput>) => {
    setToasts((current) =>
      current.map((toast) =>
        toast.id === id
          ? {
              ...toast,
              ...patch,
              id,
              createdAt: patch.duration === undefined ? toast.createdAt : Date.now(),
            }
          : toast,
      ),
    );
  }, []);

  useEffect(() => {
    const activeIds = new Set(toasts.map((toast) => toast.id));

    toastTimers.current.forEach((entry, id) => {
      if (!activeIds.has(id)) {
        window.clearTimeout(entry.timer);
        toastTimers.current.delete(id);
      }
    });

    toasts.forEach((toast) => {
      const duration = toast.duration ?? defaultDuration;
      const existing = toastTimers.current.get(toast.id);

      if (duration <= 0) {
        if (existing) {
          window.clearTimeout(existing.timer);
          toastTimers.current.delete(toast.id);
        }
        return;
      }

      const createdAt = toast.createdAt ?? Date.now();
      const signature = `${createdAt}:${duration}`;

      if (existing?.signature === signature) {
        return;
      }

      if (existing) {
        window.clearTimeout(existing.timer);
      }

      const elapsed = Date.now() - createdAt;
      const remaining = Math.max(duration - elapsed, 0);
      const timer = window.setTimeout(() => {
        toastTimers.current.delete(toast.id);
        dismissToast(toast.id);
      }, remaining);

      toastTimers.current.set(toast.id, { timer, signature });
    });
  }, [defaultDuration, dismissToast, toasts]);

  useEffect(() => {
    const timers = toastTimers.current;

    return () => {
      timers.forEach((entry) => {
        window.clearTimeout(entry.timer);
      });
      timers.clear();
    };
  }, []);

  return useMemo(
    () => ({
      toasts,
      showToast,
      updateToast,
      dismissToast,
      clearToasts,
      setToasts,
    }),
    [clearToasts, dismissToast, showToast, toasts, updateToast],
  );
}

export function AnimatedToastStack({
  toasts,
  onDismiss,
  position = "bottom-right",
  placement,
  fixed = false,
  portal,
  portalRoot,
  maxVisible = 4,
  className,
  classNames,
  icons,
  renderToast,
}: AnimatedToastStackProps) {
  const [portalTarget, setPortalTarget] = useState<Element | null>(null);
  const visibleToasts = toasts.slice(-maxVisible);
  const isBottom = position.startsWith("bottom");
  const resolvedPlacement = placement ?? (fixed ? "fixed" : "static");
  const shouldPortal = portal ?? resolvedPlacement === "fixed";

  useEffect(() => {
    setPortalTarget(shouldPortal ? (portalRoot ?? document.body) : null);
  }, [portalRoot, shouldPortal]);

  const stack = (
    <ol
      aria-live="polite"
      aria-atomic="false"
      className={cn(
        "pointer-events-none flex w-[calc(100vw-2rem)] max-w-sm gap-2",
        isBottom ? "flex-col-reverse" : "flex-col",
        resolvedPlacement === "fixed" && "fixed z-[90]",
        resolvedPlacement === "absolute" && "absolute z-20",
        resolvedPlacement !== "static" && POSITION_CLASS[position],
        classNames?.root,
        className,
      )}
    >
      <AnimatePresence initial={false} mode="popLayout">
        {visibleToasts.map((toast, index) => (
          <ToastItem
            key={toast.id}
            toast={toast}
            index={index}
            onDismiss={onDismiss}
            classNames={classNames}
            icons={icons}
            renderToast={renderToast}
          />
        ))}
      </AnimatePresence>
    </ol>
  );

  if (shouldPortal && !portalTarget) {
    return null;
  }

  if (shouldPortal && portalTarget) {
    return createPortal(stack, portalTarget);
  }

  return stack;
}

const ToastItem = memo(function ToastItem({
  toast,
  index,
  onDismiss,
  classNames,
  icons,
  renderToast,
}: {
  toast: AnimatedToast;
  index: number;
  onDismiss?: (id: string) => void;
  classNames?: ToastClassNames;
  icons?: Partial<Record<ToastStatus, ReactNode>>;
  renderToast?: (toast: AnimatedToast) => ReactNode;
}) {
  const reduce = useReducedMotion();
  const status = toast.status ?? "neutral";
  const Icon = STATUS_ICON[status];
  const iconNode = icons?.[status] ?? toast.icon ?? (Icon ? <Icon className="h-3.5 w-3.5" /> : null);
  const canDismiss = toast.dismissible !== false && Boolean(onDismiss);
  const hasDetails = Boolean(toast.description || toast.action || toast.links?.length);

  // The side a swipe flung the toast toward, so it leaves the way it was thrown.
  const [swipe, setSwipe] = useState<1 | -1>(1);

  return (
    <motion.li
      layout={!reduce}
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8 }}
      animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0 }}
      exit={
        reduce
          ? { opacity: 0 }
          : {
              opacity: 0,
              x: 32 * swipe,
              transition: { duration: 0.18, ease: EASE_OUT },
            }
      }
      transition={{ ...STACK_SPRING, opacity: { duration: 0.2, ease: EASE_OUT }, y: { duration: 0.2, ease: EASE_OUT } }}
      // Swiping is how a toast is dismissed by hand, so it stays under reduced
      // motion: the toast moves only as far as the finger moves it.
      drag={canDismiss ? "x" : false}
      dragConstraints={{ left: 0, right: 0 }}
      dragElastic={0.18}
      onDragEnd={(_, info) => {
        if (!canDismiss || !onDismiss) return;
        if (Math.abs(info.offset.x) > 72 || Math.abs(info.velocity.x) > 520) {
          setSwipe((info.offset.x || info.velocity.x) < 0 ? -1 : 1);
          onDismiss(toast.id);
        }
      }}
      className={cn("pointer-events-auto relative will-change-transform", classNames?.item)}
      style={{ zIndex: 20 - index }}
    >
      <div
        className={cn(
          "relative overflow-hidden rounded-[12px] border border-line bg-panel p-3 shadow-[0_8px_24px_rgba(0,0,0,0.12)]",
          classNames?.surface,
        )}
      >
        {renderToast ? (
          renderToast(toast)
        ) : (
          <div className={cn("flex gap-2.5", hasDetails ? "items-start" : "items-center")}>
            {iconNode ? (
            <motion.span
              layout={!reduce}
              className={cn(
                "inline-flex h-5 w-4 shrink-0 items-center justify-center",
                STATUS_CLASS[status],
                classNames?.iconWrap,
              )}
            >
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span
                  key={status}
                  initial={
                    reduce
                      ? { opacity: 0 }
                      : { opacity: 0, y: 8, scale: 0.8, filter: "blur(6px)" }
                  }
                  animate={
                    reduce
                      ? { opacity: 1 }
                      : { opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }
                  }
                  exit={
                    reduce
                      ? { opacity: 0 }
                      : { opacity: 0, y: -8, scale: 0.9, filter: "blur(6px)" }
                  }
                  transition={CONTENT_TRANSITION}
                  className="inline-flex"
                >
                  {status === "loading" ? (
                    <span className="inline-flex animate-spin">{iconNode}</span>
                  ) : (
                    iconNode
                  )}
                </motion.span>
              </AnimatePresence>
            </motion.span>
            ) : null}

            <div className={cn("min-w-0 flex-1", classNames?.content)}>
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.div
                  key={`${toast.id}-${status}-${String(toast.title)}`}
                  initial={
                    reduce
                      ? { opacity: 0 }
                      : { opacity: 0, y: 8, filter: "blur(6px)" }
                  }
                  animate={
                    reduce
                      ? { opacity: 1 }
                      : { opacity: 1, y: 0, filter: "blur(0px)" }
                  }
                  exit={
                    reduce
                      ? { opacity: 0 }
                      : { opacity: 0, y: -8, filter: "blur(6px)" }
                  }
                  transition={CONTENT_TRANSITION}
                >
                  <p
                    className={cn(
                      "truncate text-sm font-medium leading-5 text-foreground",
                      classNames?.title,
                    )}
                  >
                    {toast.title}
                  </p>
                  {toast.description ? (
                    <p
                      className={cn(
                        "mt-0.5 line-clamp-3 text-pretty text-xs leading-4 text-muted-foreground",
                        classNames?.description,
                      )}
                    >
                      {toast.description}
                    </p>
                  ) : null}
                </motion.div>
              </AnimatePresence>

              {toast.action ? (
                <button
                  type="button"
                  onClick={() => toast.action?.onClick(toast)}
                  className={cn(
                    "mt-2 inline-flex h-7 items-center rounded-[8px] border border-line px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-panel2",
                    classNames?.action,
                  )}
                >
                  {toast.action.label}
                </button>
              ) : null}

              {toast.links?.length ? (
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  {toast.links.map((link) => {
                    const external = /^https?:/.test(link.href);
                    return (
                      <span key={link.href} className="inline-flex items-center gap-2">
                        <a
                          href={link.href}
                          {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
                          // A step inside the site is the toast's last word.
                          onClick={external ? undefined : () => onDismiss?.(toast.id)}
                          className={
                            link.primary
                              ? "inline-flex h-7 items-center rounded-[8px] bg-foreground px-2.5 text-xs font-medium text-background transition-opacity hover:opacity-90"
                              : "inline-flex items-center gap-1 text-xs font-medium text-foreground underline-offset-2 hover:underline"
                          }
                        >
                          {link.label}
                          {external ? <ExternalLink className="h-3 w-3 text-muted-foreground" /> : null}
                        </a>
                        {link.aside ? (
                          <span className="font-mono text-[11px] text-muted-foreground">{link.aside}</span>
                        ) : null}
                      </span>
                    );
                  })}
                </div>
              ) : null}
            </div>

            {canDismiss ? (
              <button
                type="button"
                onClick={() => onDismiss?.(toast.id)}
                aria-label="Dismiss"
                className={cn(
                  "-my-1 -mr-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] text-muted-foreground transition-colors hover:bg-panel2 hover:text-foreground",
                  classNames?.close,
                )}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
        )}

      </div>
    </motion.li>
  );
});
