"use client";

import Link from "next/link";
import { BookImage, Briefcase, Camera, Images, Plus, Upload } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-h-14 flex-col items-center justify-center gap-0.5 px-1 py-1.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#2680FC]",
                  active ? "font-semibold text-white" : "text-[#b4b4b4]"
                )}
              >
                <span
                  className={cn(
                    "flex h-7 w-14 items-center justify-center rounded-full",
                    active && "bg-[#2680FC]/25 text-[#8bbaff]"
                  )}
                >
                  <Icon className="h-5 w-5" aria-hidden="true" />
                </span>
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

const menuItem =
  "flex min-h-11 cursor-pointer items-center gap-3 px-3 text-base text-white focus:bg-[#3e3e3e] focus:text-white";

/**
 * The phone's one round "+": Take photos, Upload, New album. It replaces the
 * two wide capture buttons, which no longer fit once the tab bar arrived and
 * ran off-screen at large text sizes.
 */
export function AddButton() {
  const hasCamera = useHasCamera();
  const { openPicker, openCamera, openNewAlbum } = usePhotosShell();

  return (
    // Not modal: "New album" opens a pop-up from this menu, and a modal menu
    // closing at the same moment can leave the page unclickable.
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Add"
          className="pointer-events-auto flex h-14 w-14 items-center justify-center rounded-full bg-[#2680FC] text-white shadow-lg shadow-black/40 hover:bg-[#1a6fd8] focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
        >
          <Plus className="h-7 w-7" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        side="top"
        sideOffset={8}
        className="min-w-52 border-[#4e4e4e] bg-[#2e2e2e] p-1 text-white"
      >
        {hasCamera && (
          <DropdownMenuItem onSelect={openCamera} className={menuItem}>
            <Camera className="h-5 w-5 text-[#b4b4b4]" aria-hidden="true" />
            Take photos
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={openPicker} className={menuItem}>
          <Upload className="h-5 w-5 text-[#b4b4b4]" aria-hidden="true" />
          Upload
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={openNewAlbum} className={menuItem}>
          <BookImage className="h-5 w-5 text-[#b4b4b4]" aria-hidden="true" />
          New album
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
