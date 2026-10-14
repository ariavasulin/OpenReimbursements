"use client";

import Link from "next/link";
import { LogOut, Receipt, Settings, Trash2, UserRound } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { signOut } from "@/hooks/use-session-guard";

// The quiet home for the things that are not browsing: Trash, Settings, the
// Receipts app, and Sign out. They used to sit in the header as peers of search and upload,
// with Sign out in red as the loudest thing on the page.
//
// The button is a filled 44px disc with a bare person glyph, the same size and
// glyph weight as the accent "+" beside it in the desktop top bar: two discs
// read as a deliberate pair, where an outline-only circle looked smaller.

const item =
  "flex min-h-11 cursor-pointer items-center gap-3 px-3 text-base text-white focus:bg-[#3e3e3e] focus:text-white";
const icon = "h-5 w-5 text-[#b4b4b4]";

export default function AccountMenu({ showTrash = false }: { showTrash?: boolean }) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Account menu"
          // A 44px tap target around a disc that is 36px on a phone (where it sits
          // beside the wordmark) and 44px on desktop (where it pairs with the "+").
          className="group flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[#d0d0d0] hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2680FC] focus-visible:ring-offset-2 focus-visible:ring-offset-[#222222] data-[state=open]:text-white"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[#2e2e2e] group-hover:bg-[#3a3a3a] group-data-[state=open]:bg-[#3a3a3a] desktop:h-11 desktop:w-11">
            <UserRound className="h-5 w-5 desktop:h-6 desktop:w-6" aria-hidden="true" />
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={6}
        className="min-w-52 border-[#4e4e4e] bg-[#2e2e2e] p-1 text-white"
      >
        {showTrash && (
          <DropdownMenuItem asChild className={item}>
            <Link href="/photos/trash">
              <Trash2 className={icon} aria-hidden="true" />
              Trash
            </Link>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem asChild className={item}>
          <Link href="/photos/settings">
            <Settings className={icon} aria-hidden="true" />
            Settings
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild className={item}>
          <Link href="/employee">
            <Receipt className={icon} aria-hidden="true" />
            Receipts
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator className="bg-[#4e4e4e]" />
        <DropdownMenuItem onSelect={() => void signOut()} className={item}>
          <LogOut className={icon} aria-hidden="true" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
