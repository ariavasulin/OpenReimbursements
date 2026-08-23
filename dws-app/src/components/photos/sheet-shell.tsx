"use client";

import type { ReactNode } from "react";
import { useMobile } from "@/hooks/use-mobile";
import { useKeyboardInset } from "@/hooks/use-keyboard-inset";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import { cn } from "@/lib/utils";

// Fixed-size form sheet: Drawer on phones, Dialog on desktop. The frame never
// resizes while the user interacts — header and footer are pinned and only the
// middle scrolls. On phones, vaul's input repositioning is off and the drawer
// is lifted above the software keyboard by useKeyboardInset instead.

interface SheetShellProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Accessible name; rendered visually hidden. */
  title: string;
  /** Pinned above the scroll body. */
  header?: ReactNode;
  /** The scrolling middle. */
  children: ReactNode;
  /** Pinned below the scroll body (primary action lives here). */
  footer: ReactNode;
  /** Rendered after the footer, inside the content — for nested full-screen dialogs. */
  extra?: ReactNode;
  /** Mobile drawer height classes. */
  heightClass?: string;
  /** Desktop dialog height classes. */
  desktopClass?: string;
}

export default function SheetShell({
  open,
  onOpenChange,
  title,
  header,
  children,
  footer,
  extra,
  heightClass = "h-[85dvh] max-h-[85dvh]",
  desktopClass = "h-[min(85dvh,640px)] max-h-[85dvh]",
}: SheetShellProps) {
  const isMobile = useMobile();
  const keyboardInset = useKeyboardInset(isMobile && open);

  const body = (
    <>
      {header && <div className="shrink-0 px-4 pt-1">{header}</div>}

      <div
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-3"
        onFocusCapture={(event) => {
          const target = event.target as HTMLElement;
          // After the keyboard animates in (~250ms) and the drawer has lifted.
          setTimeout(
            () => target.scrollIntoView({ block: "nearest", behavior: "smooth" }),
            300
          );
        }}
      >
        {children}
      </div>

      <div className="shrink-0 border-t border-[#3e3e3e] px-4 pb-[calc(1rem_+_env(safe-area-inset-bottom))] pt-3">
        {footer}
      </div>
    </>
  );

  if (isMobile) {
    return (
      <Drawer
        open={open}
        onOpenChange={onOpenChange}
        repositionInputs={false}
      >
        <DrawerContent
          className={cn(
            "border-[#4e4e4e] bg-[#2e2e2e] transition-[bottom] duration-150",
            heightClass
          )}
          style={{
            bottom: keyboardInset,
            maxHeight: `calc(100dvh - ${keyboardInset}px - 2rem)`,
          }}
        >
          <DrawerTitle className="sr-only">{title}</DrawerTitle>
          {body}
          {extra}
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          "flex flex-col gap-0 overflow-hidden border-none bg-[#2e2e2e] p-0 sm:max-w-md",
          desktopClass
        )}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        {body}
        {extra}
      </DialogContent>
    </Dialog>
  );
}
