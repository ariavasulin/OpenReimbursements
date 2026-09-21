"use client";

import Link from "next/link";
import { Camera, FolderInput, Upload } from "lucide-react";
import AccountMenu from "@/components/photos/account-menu";
import { useHasCamera } from "@/components/photos/multi-shot-camera";
import { usePhotosShell } from "@/components/photos/photos-shell-context";
import SearchBox from "@/components/photos/search-box";

/**
 * Desktop-only header: the name, search, and the ways to add photos. Receipts
 * and Sign out live in the account menu at the far right; Trash is at the foot
 * of the left rail. Only mounted when useDesktop() is true — no desktop:
 * guards needed here.
 */
const action =
  "flex min-h-10 shrink-0 items-center gap-2 rounded-lg px-3 text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2680FC]";

export default function TopBar() {
  const { openPicker, openCamera } = usePhotosShell();
  const hasCamera = useHasCamera();

  return (
    <div className="shrink-0 border-b border-[#444444]">
      <div className="flex min-h-16 items-center gap-4 px-4 py-2 md:px-6">
        <Link
          href="/photos"
          className="shrink-0 text-base font-semibold tracking-wide xl:w-[256px]"
        >
          DWS <span className="text-[#2680FC]">Photos</span>
        </Link>

        <SearchBox className="w-full max-w-md" />

        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Link
            href="/migrate"
            className={`${action} text-[#d0d0d0] hover:bg-[#333333] hover:text-white`}
          >
            <FolderInput className="h-4 w-4" aria-hidden="true" />
            Import folders
          </Link>
          {hasCamera && (
            <button
              type="button"
              onClick={openCamera}
              className={`${action} bg-[#333333] text-white hover:bg-[#444444]`}
            >
              <Camera className="h-4 w-4" aria-hidden="true" />
              Take photos
            </button>
          )}
          <button
            type="button"
            onClick={openPicker}
            className={`${action} bg-[#2680FC] text-white hover:bg-[#1a6fd8]`}
          >
            <Upload className="h-4 w-4" aria-hidden="true" />
            Upload
          </button>
          <AccountMenu />
        </div>
      </div>
    </div>
  );
}
