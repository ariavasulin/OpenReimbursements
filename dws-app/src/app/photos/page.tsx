"use client";

import { Images, Upload } from "lucide-react";
import EmptyState, { emptyPrimary } from "@/components/photos/empty-state";
import { PAGE_MAIN_CLASS, PAGE_TITLE_CLASS } from "@/components/photos/page-layout";
import PhoneHeader from "@/components/photos/phone-header";
import PhotoBrowser from "@/components/photos/photo-browser";
import { usePhotosShell } from "@/components/photos/photos-shell-context";

/** Photos: every photo, newest first, on phone and desktop alike. */
export default function PhotosPage() {
  const { openPicker } = usePhotosShell();

  return (
    <main className={PAGE_MAIN_CLASS}>
      <PhoneHeader />
      <h1 className={`mb-3 ${PAGE_TITLE_CLASS}`}>Photos</h1>
      <PhotoBrowser
        scope={{ kind: "all" }}
        empty={
          <EmptyState
            icon={<Images className="h-7 w-7" aria-hidden="true" />}
            title="No photos yet"
            actions={
              <button type="button" onClick={openPicker} className={emptyPrimary}>
                <Upload className="h-5 w-5" aria-hidden="true" />
                Upload photos
              </button>
            }
          >
            Every photo anyone uploads shows up here, newest first.
          </EmptyState>
        }
      />
    </main>
  );
}
