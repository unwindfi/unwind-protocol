// Adapted from sales-crm by Kargul Studio (MIT), components/_ui/command.tsx; see THIRD_PARTY_NOTICES.md.
/*
 * The command menu's parts: cmdk for the search, the list and the arrow
 * keys, inside a Radix dialog for the focus trap, the scroll lock and Escape.
 * Restyled in the house look: one flat panel on a hairline, no blur behind
 * it, an 8px row highlight in the panel's own step up.
 */
import type { ComponentProps, ReactNode } from "react";
import { Command as CommandPrimitive } from "cmdk";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";

type CommandDialogProps = ComponentProps<typeof DialogPrimitive.Root> & {
  title: string;
  description: string;
  className?: string;
  onCloseAutoFocus?: ComponentProps<typeof DialogPrimitive.Content>["onCloseAutoFocus"];
};

export function CommandDialog({
  title, description, className, children, onCloseAutoFocus, ...props
}: CommandDialogProps) {
  return (
    <DialogPrimitive.Root {...props}>
      <DialogPrimitive.Portal>
        {/* A flat scrim: a blur over the live chart re-rasterises the whole
            viewport on every tick behind it. */}
        <DialogPrimitive.Overlay className="fixed inset-0 z-[100] bg-background/60" />
        <DialogPrimitive.Content
          onCloseAutoFocus={onCloseAutoFocus}
          className={cn(
            "fixed left-1/2 top-[12dvh] z-[100] w-[calc(100%-2rem)] max-w-[600px] -translate-x-1/2",
            "overflow-hidden rounded-[12px] border border-line bg-panel text-foreground outline-none",
            "shadow-[0_24px_60px_-20px_rgba(0,0,0,.35)]",
            className,
          )}
        >
          <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">{description}</DialogPrimitive.Description>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function Command({ className, ...props }: ComponentProps<typeof CommandPrimitive>) {
  return <CommandPrimitive loop className={cn("flex flex-col", className)} {...props} />;
}

export function CommandInput({
  className, trailing, ...props
}: ComponentProps<typeof CommandPrimitive.Input> & { trailing?: ReactNode }) {
  return (
    <div className="flex h-12 items-center gap-2.5 border-b border-line px-4">
      <Search size={16} strokeWidth={1.75} aria-hidden className="flex-none text-muted-foreground" />
      <CommandPrimitive.Input
        className={cn(
          // 16px on a touch screen, or iOS zooms the page in on focus.
          "h-full min-w-0 flex-1 bg-transparent text-[14px] text-foreground outline-none",
          "placeholder:text-muted-foreground pointer-coarse:text-base",
          className,
        )}
        {...props}
      />
      {trailing}
    </div>
  );
}

export function CommandList({ className, ...props }: ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      className={cn("max-h-[min(420px,60dvh)] overflow-y-auto overscroll-contain p-1.5", className)}
      {...props}
    />
  );
}

export function CommandEmpty({ className, ...props }: ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      className={cn("py-10 text-center text-[13px] text-muted-foreground", className)}
      {...props}
    />
  );
}

export function CommandGroup({ className, ...props }: ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      className={cn(
        "[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1.5 [&_[cmdk-group-heading]]:pt-2",
        "[&_[cmdk-group-heading]]:text-[12px] [&_[cmdk-group-heading]]:text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function CommandItem({ className, ...props }: ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      className={cn(
        "flex h-11 cursor-pointer select-none items-center gap-3 rounded-[8px] px-2.5 text-[14px]",
        "text-muted-foreground outline-none",
        "data-[selected=true]:bg-panel2 data-[selected=true]:text-foreground",
        "data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export function CommandSeparator({ className, ...props }: ComponentProps<typeof CommandPrimitive.Separator>) {
  return <CommandPrimitive.Separator className={cn("-mx-1.5 my-1.5 h-px bg-line", className)} {...props} />;
}

export function CommandFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex h-10 items-center gap-4 border-t border-line px-4 text-[12px] text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function Kbd({ className, ...props }: ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-[6px] border border-line bg-panel2",
        "px-1.5 font-sans text-[11px] text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}
