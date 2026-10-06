import type { ToastInput } from "@/components/motion/animated-toast-stack";

/*
 * One toast stack for the whole site.
 *
 * The stack itself is a component (`ToastHost`), mounted once beside the
 * page, so a toast outlives the page that raised it: a listing can finish
 * confirming after its page has been left. Anything can raise or update a
 * toast through `toast` without a provider above it, which is what lets
 * `signAndSend` own a transaction's toast from start to end.
 *
 * Calls made before the host has mounted wait for it.
 */
interface ToastApi {
  show: (input: ToastInput) => string;
  update: (id: string, patch: Partial<ToastInput>) => void;
  dismiss: (id: string) => void;
}

let api: ToastApi | null = null;
const waiting: ((a: ToastApi) => void)[] = [];
let seed = 0;

const run = (f: (a: ToastApi) => void) => (api ? f(api) : void waiting.push(f));

export const toast = {
  /// Raises a toast and returns its id, for updating it in place later.
  show(input: ToastInput): string {
    const id = input.id ?? `toast-${Date.now()}-${seed++}`;
    run((a) => a.show({ ...input, id }));
    return id;
  },
  /// Changes a toast in place. Passing a `duration` restarts its timer.
  update(id: string, patch: Partial<ToastInput>) {
    run((a) => a.update(id, patch));
  },
  dismiss(id: string) {
    run((a) => a.dismiss(id));
  },
};

export const useToast = () => toast;

/// Called by the host when it mounts; returns its own detach.
export function attachToasts(a: ToastApi) {
  api = a;
  waiting.splice(0).forEach((f) => f(a));
  return () => { if (api === a) api = null; };
}
