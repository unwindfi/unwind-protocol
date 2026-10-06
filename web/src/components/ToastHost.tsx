import { useEffect } from "react";
import { AnimatedToastStack, useAnimatedToastStack } from "@/components/motion/animated-toast-stack";
import { attachToasts } from "@/lib/toasts";
import { useIsMobile } from "@/lib/media";

/// The site's one toast stack. Bottom right on a wide screen; on a phone it
/// sits at the top, clear of the Buy/Sell bar and the sheets that rise from
/// the bottom edge.
export default function ToastHost() {
  const { toasts, showToast, updateToast, dismissToast } = useAnimatedToastStack({ limit: 4 });
  const isMobile = useIsMobile();

  useEffect(
    () => attachToasts({ show: showToast, update: updateToast, dismiss: dismissToast }),
    [showToast, updateToast, dismissToast],
  );

  return (
    <AnimatedToastStack toasts={toasts} onDismiss={dismissToast}
      position={isMobile ? "top-center" : "bottom-right"} placement="fixed" />
  );
}
