"use client";

import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { patchFavorites, setFavorites, usePhotoActor } from "@/lib/photos/api";
import { isFavorite, type PhotoRow } from "@/lib/photos/types";

/**
 * The heart on one photo: whether it is the signed-in person's favorite, and a
 * toggle that fills or empties it at once and tells the server after. If the
 * server refuses, the heart goes back and a toast says so.
 */
export function useFavorite() {
  const queryClient = useQueryClient();
  const me = usePhotoActor()?.user_id ?? null;
  const toggle = useCallback(
    async (photo: Pick<PhotoRow, "id" | "favorites">) => {
      if (!me) return;
      const next = !isFavorite(photo, me);
      patchFavorites(queryClient, [photo.id], me, next);
      try {
        await setFavorites([photo.id], next);
      } catch (error) {
        patchFavorites(queryClient, [photo.id], me, !next);
        toast.error(error instanceof Error ? error.message : "Could not update favorites");
      }
    },
    [queryClient, me]
  );
  return { me, favorite: (photo: Pick<PhotoRow, "favorites">) => isFavorite(photo, me), toggle };
}
