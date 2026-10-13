"use client";

import Link from "next/link";
import AccountMenu from "@/components/photos/account-menu";
import SearchBox from "@/components/photos/search-box";
import { TopBarAddButton } from "@/components/photos/section-nav";

/**
 * Desktop-only header: the name, search, one "+" that holds every way to add
 * something (the same menu as the phone's "+"), and the account menu, which
 * carries Receipts and Sign out. Trash is at the foot of the left rail. Only
 * mounted when useDesktop() is true — no desktop: guards needed here.
 */
export default function TopBar() {
  return (
    <div className="shrink-0 border-b border-[#444444]">
      <div className="flex min-h-16 items-center gap-4 px-4 py-2 md:px-6">
        <Link
          href="/photos"
          className="flex min-h-11 shrink-0 items-center gap-1 text-base font-semibold tracking-wide xl:w-[256px]"
        >
          DWS <span className="text-[#2680FC]">Photos</span>
        </Link>

        <SearchBox className="w-full max-w-md" />

        <div className="ml-auto flex shrink-0 items-center gap-3">
          <TopBarAddButton />
          <AccountMenu />
        </div>
      </div>
    </div>
  );
}
