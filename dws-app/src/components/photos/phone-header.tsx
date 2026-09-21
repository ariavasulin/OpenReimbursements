"use client";

import Link from "next/link";
import { useDesktop } from "@/hooks/use-desktop";
import AccountMenu from "@/components/photos/account-menu";
import SearchBox from "@/components/photos/search-box";

/**
 * Phone-only page top. The three section pages show the name, the account menu
 * (Trash, Receipts, Sign out) and search; a page inside a section shows a way
 * back to it instead. Hidden at desktop, where the top bar and rail do this.
 */
export default function PhoneHeader({
  back,
}: {
  /** Inside a section: where "back" goes and what it is called. */
  back?: { href: string; label: string };
}) {
  // The header is hidden at desktop by CSS (no flash before hydration); its
  // search field is also left out there, so the top bar's is the only one.
  const isDesktop = useDesktop();
  return (
    <header className="desktop:hidden mb-3">
      <div className="flex min-h-11 items-center justify-between gap-2">
        {back ? (
          <Link
            href={back.href}
            className="-ml-2 flex min-h-11 items-center gap-1 rounded-lg px-2 text-base font-medium text-[#8bbaff]"
          >
            <span aria-hidden="true">&lsaquo;</span>
            {back.label}
          </Link>
        ) : (
          <Link href="/photos" className="text-lg font-semibold tracking-wide">
            DWS <span className="text-[#2680FC]">Photos</span>
          </Link>
        )}
        <AccountMenu showTrash />
      </div>
      {!back && !isDesktop && <SearchBox className="mt-1" />}
    </header>
  );
}
