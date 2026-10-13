"use client";

import Link from "next/link";
import { BookImage, Briefcase, Camera, FolderInput, Images, Plus, Upload } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { menuClass, menuItemClass } from "@/components/photos/filter-bar";
import { useHasCamera } from "@/components/photos/multi-shot-camera";
import {
  usePhotosShell,
  type PhotoSection,
} from "@/components/photos/photos-shell-context";
import { cn } from "@/lib/utils";

// The three ways to browse, one tap apart: a bottom tab bar on phones, the top
// of the left rail on desktop. Same three entries, same order, same words.

export const SECTIONS: {
  id: PhotoSection;
  label: string;
  href: string;
  icon: typeof Images;
}[] = [
  { id: "photos", label: "Photos", href: "/photos", icon: Images },
  { id: "albums", label: "Albums", href: "/photos/albums", icon: BookImage },
  { id: "projects", label: "Projects", href: "/photos/projects", icon: Briefcase },
];

/**
 * Phone tab bar. A flex child of the shell, not `position: fixed`: the page
 * above it simply ends where the bar begins, so nothing hides behind it and
 * nothing needs to know its height — which grows with the reader's text size.
 */
export function BottomNav() {
  const { section } = usePhotosShell();
  return (
    <nav
      aria-label="Sections"
      className="shrink-0 border-t border-[#3e3e3e] bg-[#262626] pb-[env(safe-area-inset-bottom)]"
    >
      <ul className="mx-auto grid max-w-3xl grid-cols-3">
        {SECTIONS.map(({ id, label, href, icon: Icon }) => {
          const active = id === section;
          return (
            <li key={id}>
              {/* The whole cell is the target; the active one tints its icon
                  and label together inside one soft pill. */}
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className="group flex min-h-14 items-center justify-center px-1 py-1.5 focus:outline-none"
              >
                <span
                  className={cn(
                    "flex min-w-20 flex-col items-center gap-0.5 rounded-2xl px-3 py-1 text-sm group-focus-visible:ring-2 group-focus-visible:ring-[#2680FC]",
                    active
                      ? "bg-[#2680FC]/20 font-semibold text-[#8bbaff]"
                      : "text-[#b4b4b4]"
                  )}
                >
                  <Icon className="h-6 w-6" aria-hidden="true" />
                  {label}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

const menuItem = cn(menuItemClass, "group cursor-pointer gap-3");
const menuIcon = "h-5 w-5 text-[#b4b4b4] group-focus:text-white";

/**
 * Everything that adds something, behind one "+": the phone's round floating
 * button and the desktop top bar open this same menu, with the same five rows
 * in the same order and words.
 */
function AddMenu({
  trigger,
  side,
}: {
  trigger: React.ReactElement;
  side: "top" | "bottom";
}) {
  const hasCamera = useHasCamera();
  const { openPicker, openCamera, openNewProject, openNewAlbum } = usePhotosShell();

  return (
    // Not modal: "New project" and "New album" open a pop-up from this menu,
    // and a modal menu closing at the same moment can leave the page
    // unclickable.
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        side={side}
        sideOffset={8}
        className={cn("min-w-56", menuClass)}
      >
        <DropdownMenuItem onSelect={openPicker} className={menuItem}>
          <Upload className={menuIcon} aria-hidden="true" />
          Upload photos
        </DropdownMenuItem>
        {hasCamera && (
          <DropdownMenuItem onSelect={openCamera} className={menuItem}>
            <Camera className={menuIcon} aria-hidden="true" />
            Take photos
          </DropdownMenuItem>
        )}
        <DropdownMenuItem asChild className={menuItem}>
          <Link href="/migrate">
            <FolderInput className={menuIcon} aria-hidden="true" />
            Import folders
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={openNewProject} className={menuItem}>
          <Briefcase className={menuIcon} aria-hidden="true" />
          New project
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={openNewAlbum} className={menuItem}>
          <BookImage className={menuIcon} aria-hidden="true" />
          New album
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The phone's round floating "+", above the tab bar. */
export function AddButton() {
  return (
    <AddMenu
      side="top"
      trigger={
        <button
          type="button"
          aria-label="Add"
          className="pointer-events-auto flex h-14 w-14 items-center justify-center rounded-full bg-[#2680FC] text-white shadow-lg shadow-black/40 hover:bg-[#1a6fd8] focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
        >
          <Plus className="h-7 w-7" aria-hidden="true" />
        </button>
      }
    />
  );
}

/** The desktop top bar's "+", beside the account button. */
export function TopBarAddButton() {
  return (
    <AddMenu
      side="bottom"
      trigger={
        <button
          type="button"
          aria-label="Add"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#2680FC] text-white hover:bg-[#1a6fd8] focus:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-[#222222]"
        >
          <Plus className="h-6 w-6" aria-hidden="true" />
        </button>
      }
    />
  );
}
