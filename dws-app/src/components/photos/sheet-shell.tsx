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

// Fixed-size form sheet: Drawer on phones, Dialog on desktop. The frame never
// resizes while the user interacts — header and footer are pinned and only the
// middle scrolls. On phones, vaul's input repositioning is off and the drawer
// is lifted above the software keyboard by useKeyboardInset instead.

// The drawer's `bottom` transition (see DrawerContent's duration-150 class); a
// focused field is scrolled into view only after the keyboard has animated in
// (~250ms) and that lift has finished.
const KEYBOARD_SETTLE_MS = 300;

// Gap kept above the drawer so it never covers the whole screen.
const DRAWER_TOP_GAP = "2rem";

const SIZES = {
  full: {
    mobile: "h-[85dvh] max-h-[85dvh]",
    desktop: "h-[min(85dvh,640px)] max-h-[85dvh]",
  },
  compact: {
    mobile: "h-[70dvh] max-h-[70dvh]",
    desktop: "h-[min(85dvh,520px)] max-h-[85dvh]",
  },
} as const;

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
  /** Pinned below the scroll body (primary action lives here). */
  footer: ReactNode;
  size?: keyof typeof SIZES;
}

export default function SheetShell({
  open,
  onOpenChange,
  title,
  header,
  children,
  footer,
  size = "full",
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
      target.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }, KEYBOARD_SETTLE_MS);
  };

  const titleClass = "mb-3 text-[15px] font-semibold text-white";

  const body = (titleNode: ReactNode) => (
    <SheetLayoutContext.Provider value={{ isMobile }}>
      <div className="shrink-0 px-4 pt-1">
        {titleNode}
        {header}
      </div>

      <div
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-3"
        onFocusCapture={
          isMobile
            ? (event) => scrollFocusedIntoView(event.target as HTMLElement)
            : undefined
        }
      >
        {children}
      </div>

      <div className="shrink-0 border-t border-[#3e3e3e] px-4 pb-[calc(1rem_+_env(safe-area-inset-bottom))] pt-3">
        {footer}
      </div>
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
            "border-[#4e4e4e] bg-[#2e2e2e] transition-[bottom] duration-150 [&::after]:h-[unset]",
            SIZES[size].mobile
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
          "flex flex-col gap-0 overflow-hidden border-none bg-[#2e2e2e] p-0 sm:max-w-md",
          SIZES[size].desktop
        )}
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
