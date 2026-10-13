"use client";

import { Heart } from "lucide-react";
import EmptyState from "@/components/photos/empty-state";
import { PAGE_MAIN_CLASS, PAGE_SUBTITLE_CLASS, PAGE_TITLE_CLASS } from "@/components/photos/page-layout";
import PhoneHeader from "@/components/photos/phone-header";
import PhotoBrowser from "@/components/photos/photo-browser";

/**
 * Favorites: the photos this person has put a heart on, across every project,
 * newest first and grouped by project. Personal: nobody else sees these, and
 * nobody else's hearts show here.
 */
export default function FavoritesPage() {
  return (
    <main className={PAGE_MAIN_CLASS}>
      <PhoneHeader />
      <div className="mb-3">
        <h1 className={PAGE_TITLE_CLASS}>Favorites</h1>
        <p className={PAGE_SUBTITLE_CLASS}>Photos you put a heart on. Only you see these.</p>
      </div>
      <PhotoBrowser
        scope={{ kind: "favorites" }}
        groupModes={["job", "date", "tag", "uploader", "type"] as const}
        empty={
          <EmptyState
            icon={<Heart className="h-7 w-7" aria-hidden="true" />}
            title="No favorites yet"
          >
            Open any photo and tap the heart to keep it here. Only you see your favorites.
          </EmptyState>
        }
      />
    </main>
  );
}
