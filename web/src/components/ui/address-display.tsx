"use client";

import { CheckIcon, CopyIcon, ExternalLinkIcon } from "lucide-react";
import React, { useState, useCallback } from "react";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";
import { DUR } from "@/lib/ease";

export interface AddressDisplayProps extends React.HTMLAttributes<HTMLSpanElement> {
  address: string;
  truncate?: boolean;
  truncateChars?: [number, number];
  copyable?: boolean;
  explorerUrl?: string;
}

const formatAddress = (
  address: string,
  truncate: boolean,
  chars: [number, number]
) => {
  if (!truncate || address.length <= chars[0] + chars[1] + 3) return address;
  return `${address.slice(0, chars[0])}…${address.slice(-chars[1])}`;
};

const springIcon = {
  type: "spring" as const,
  stiffness: 500,
  damping: 25,
  mass: 0.6,
};

export const AddressDisplay = ({
  address,
  truncate = true,
  truncateChars = [4, 4],
  copyable = true,
  explorerUrl,
  className,
  ...props
}: AddressDisplayProps) => {
  const [copied, setCopied] = useState(false);
  const shouldReduceMotion = useReducedMotion();

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      console.error("Failed to copy address to clipboard");
    }
  }, [address]);

  const displayed = formatAddress(address, truncate, truncateChars);
  const fullUrl = explorerUrl
    ? `${explorerUrl.replace(/\/+$/, "")}/${address}`
    : undefined;

  return (
    <span
      data-slot="address-display"
      className={cn(
        "inline-flex items-center gap-2 text-foreground",
        className
      )}
      {...props}
    >
      <span className="font-mono" title={address}>
        {displayed}
      </span>
      {copyable && (
        <motion.button
          type="button"
          whileTap={shouldReduceMotion ? undefined : { scale: 0.96 }}
          transition={springIcon}
          onClick={handleCopy}
          className="p-1 rounded-md text-muted-foreground hover:text-foreground transition-colors cursor-pointer outline-none focus-visible:ring-1 focus-visible:ring-ring"
          aria-label="Copy address"
        >
          <AnimatePresence mode="wait" initial={false}>
            {copied ? (
              <motion.span
                key="copied"
                initial={shouldReduceMotion ? false : { opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={shouldReduceMotion ? undefined : { opacity: 0, scale: 0.9 }}
                transition={{ duration: DUR.fast }}
                className="flex items-center"
              >
                <CheckIcon className="size-3.5 text-up" />
              </motion.span>
            ) : (
              <motion.span
                key="copy"
                initial={shouldReduceMotion ? false : { opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={shouldReduceMotion ? undefined : { opacity: 0, scale: 0.9 }}
                transition={{ duration: DUR.fast }}
                className="flex items-center"
              >
                <CopyIcon className="size-3.5" />
              </motion.span>
            )}
          </AnimatePresence>
        </motion.button>
      )}
      {fullUrl && (
        <motion.a
          whileTap={shouldReduceMotion ? undefined : { scale: 0.96 }}
          transition={springIcon}
          href={fullUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="p-1 rounded-md text-muted-foreground hover:text-foreground transition-colors cursor-pointer outline-none focus-visible:ring-1 focus-visible:ring-ring"
          aria-label="View in explorer"
        >
          <ExternalLinkIcon className="size-3.5" />
        </motion.a>
      )}
    </span>
  );
};

export interface CopyButtonProps extends React.ComponentProps<typeof motion.button> {
  textToCopy: string;
  label?: string;
  copiedLabel?: string;
}



export const CopyButton = ({
  textToCopy,
  label = "Copy",
  copiedLabel = "Copied!",
  className,
  ...props
}: CopyButtonProps) => {
  const [copied, setCopied] = useState(false);
  const shouldReduceMotion = useReducedMotion();

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(textToCopy);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      console.error("Failed to copy text to clipboard");
    }
  }, [textToCopy]);

  return (
    <motion.button
      type="button"
      whileTap={shouldReduceMotion ? undefined : { scale: 0.96 }}
      transition={springIcon}
      onClick={handleCopy}
      className={cn(
        "inline-flex items-center gap-2 px-3.5 py-2 rounded-xl border border-line bg-panel2 text-xs font-semibold text-foreground cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className
      )}
      {...props}
    >
      <AnimatePresence mode="wait" initial={false}>
        {copied ? (
          <motion.span
            key="copied"
            initial={shouldReduceMotion ? false : { opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={shouldReduceMotion ? undefined : { opacity: 0, scale: 0.9 }}
            transition={{ duration: DUR.fast }}
            className="flex items-center gap-1.5 text-up"
          >
            <CheckIcon className="size-3.5" />
            <span>{copiedLabel}</span>
          </motion.span>
        ) : (
          <motion.span
            key="copy"
            initial={shouldReduceMotion ? false : { opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={shouldReduceMotion ? undefined : { opacity: 0, scale: 0.9 }}
            transition={{ duration: DUR.fast }}
            className="flex items-center gap-1.5"
          >
            <CopyIcon className="size-3.5 text-muted-foreground" />
            <span>{label}</span>
          </motion.span>
        )}
      </AnimatePresence>
    </motion.button>
  );
};

export default AddressDisplay;

