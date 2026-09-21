"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import { useMobile } from "@/hooks/use-mobile";
import { useKeyboardInset } from "@/hooks/use-keyboard-inset";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import { cn } from "@/lib/utils";

// Form pop-up: Drawer on phones, Dialog on desktop. It is as tall as its
// content, up to a viewport-relative maximum; past that the header and footer
// stay pinned and only the middle scrolls. On phones, vaul's input
// repositioning is off and the drawer is lifted above the software keyboard by
// useKeyboardInset instead. The phone header always carries a visible, labeled
// Cancel: a drag handle alone does not say "leave without saving".

// A focused field is scrolled into view only after the iOS keyboard has
// finished animating in (~250ms), so the scroll targets the settled layout.
const KEYBOARD_SETTLE_MS = 300;

// Gap kept above the drawer so it never covers the whole screen.
const DRAWER_TOP_GAP = "2rem";

const SheetLayoutContext = createContext<{ isMobile: boolean }>({
  isMobile: false,
});

/** Whether the enclosing SheetShell is the phone (Drawer) variant. */
export function useSheetLayout() {
  return useContext(SheetLayoutContext);
}

interface SheetShellProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Visible heading, also the dialog's accessible name. */
  title: string;
  /** Pinned under the title, above the scroll body. */
  header?: ReactNode;
  /** The scrolling middle. Nested full-screen steps can go here too. */
  children: ReactNode;
  /** Pinned below the scroll body (primary action lives here). Optional: a
   *  pop-up that only shows things (the phone viewer's Details) has none. */
  footer?: ReactNode;
  /** Label of the phone header's leave-without-saving button. */
  cancelLabel?: string;
  /** No longer has an effect: the pop-up is as tall as its content. Still
   *  accepted so callers written for the fixed sizes keep compiling. */
  size?: "full" | "compact";
}

export default function SheetShell({
  open,
  onOpenChange,
  title,
  header,
  children,
  footer,
  cancelLabel = "Cancel",
}: SheetShellProps) {
  const isMobile = useMobile();
  const keyboardInset = useKeyboardInset(isMobile && open);
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (scrollTimer.current !== null) clearTimeout(scrollTimer.current);
    };
  }, []);

  const scrollFocusedIntoView = (target: HTMLElement) => {
    if (scrollTimer.current !== null) clearTimeout(scrollTimer.current);
    scrollTimer.current = setTimeout(() => {
      scrollTimer.current = null;
      target.scrollIntoView({
        block: "nearest",
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
      });
    }, KEYBOARD_SETTLE_MS);
  };

  const titleClass = "min-w-0 flex-1 break-words text-base font-semibold text-white";

  const body = (titleNode: ReactNode) => (
    <SheetLayoutContext.Provider value={{ isMobile }}>
      <div className="shrink-0 px-4 pt-1">
        {/* pr-8 at desktop keeps a long title clear of the dialog's own X. */}
        <div className={cn("mb-2 flex min-h-11 items-center gap-3", !isMobile && "pr-8")}>
          {titleNode}
          {isMobile && (
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="-mr-2 flex min-h-11 shrink-0 items-center rounded-lg px-3 text-base font-medium text-[#8bbaff] active:bg-white/10"
            >
              {cancelLabel}
            </button>
          )}
        </div>
        {header}
      </div>

      <div
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-3"
        onFocusCapture={
          isMobile
            ? (event) => {
                const target = event.target as HTMLElement;
                // Only text entry raises the keyboard; buttons don't need it.
                if (target.matches("input, textarea, [contenteditable]")) {
                  scrollFocusedIntoView(target);
                }
              }
            : undefined
        }
      >
        {children}
      </div>

      {footer ? (
        <div className="shrink-0 border-t border-[#3e3e3e] px-4 pb-[calc(1rem_+_env(safe-area-inset-bottom))] pt-3">
          {footer}
        </div>
      ) : (
        <div className="h-[calc(0.5rem_+_env(safe-area-inset-bottom))] shrink-0" />
      )}
    </SheetLayoutContext.Provider>
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
            // vaul adds an ::after filler under bottom drawers that clips
            // scrolled content once the drawer has a fixed height (vaul #575).
            // `!` because vaul's stylesheet is unlayered and beats a layered
            // utility.
            "h-auto border-[#4e4e4e] bg-[#2e2e2e] text-white [&::after]:h-[unset]!"
          )}
          style={{
            bottom: keyboardInset,
            maxHeight: `calc(100dvh - ${keyboardInset}px - ${DRAWER_TOP_GAP})`,
          }}
        >
          {body(
            <DrawerTitle className={cn("leading-normal tracking-normal", titleClass)}>
              {title}
            </DrawerTitle>
          )}
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          // Hung from a fixed top edge, not centered: a pop-up that grows (a
          // suggestion list opening) then only extends downward, instead of
          // its title and fields jumping up under the pointer.
          "top-[8dvh] flex h-auto max-h-[84dvh] translate-y-0 flex-col gap-0 overflow-hidden border-none bg-[#2e2e2e] p-0 text-white sm:max-w-md"
        )}
        // The forms describe themselves with visible labels; without this Radix
        // warns about a missing description on every open.
        aria-describedby={undefined}
      >
        {body(
          <DialogTitle className={cn("leading-normal tracking-normal", titleClass)}>
            {title}
          </DialogTitle>
        )}
      </DialogContent>
    </Dialog>
  );
}
