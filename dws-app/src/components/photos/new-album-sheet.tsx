"use client";

import { useEffect, useId, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import SheetShell from "@/components/photos/sheet-shell";
import { createAlbum, invalidatePhotoCaches } from "@/lib/photos/api";
import type { PhotoAlbum } from "@/lib/photos/types";

export const ALBUM_EXPLAINER = "Like a folder. A photo can be in more than one.";
export const PROJECT_EXPLAINER = "The job a photo belongs to. Optional.";

/** "New album": one name field. Names need not be unique. */
export default function NewAlbumSheet({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  onCreated(album: PhotoAlbum): void;
}) {
  const queryClient = useQueryClient();
  const inputId = useId();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) {
      setName("");
      setError("");
    }
  }, [open]);

  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const { album } = await createAlbum(name.trim());
      invalidatePhotoCaches(queryClient);
      toast.success(`Album “${album.name}” created`);
      onOpenChange(false);
      onCreated(album);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Failed to create the album");
    } finally {
      setBusy(false);
    }
  };

  return (
    <SheetShell
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        onOpenChange(next);
      }}
      title="New album"
      footer={
        <Button
          onClick={() => void create()}
          disabled={busy || !name.trim()}
          className="h-auto min-h-11 w-full bg-[#2680FC] py-2.5 text-base text-white hover:bg-[#1a6fd8]"
          size="lg"
        >
          {busy ? "Creating..." : "Create album"}
        </Button>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <label htmlFor={inputId} className="mb-1.5 block text-base font-medium text-[#d0d0d0]">
          Album name
        </label>
        <input
          id={inputId}
          autoFocus
          value={name}
          maxLength={120}
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
          placeholder="e.g. Christmas Party"
          className="min-h-11 w-full rounded-lg border border-[#3e3e3e] bg-[#3e3e3e] px-3 py-2.5 text-base text-white placeholder:text-[#b4b4b4] focus:border-[#2680FC] focus:outline-none"
        />
        <p className="mt-2 text-base text-[#b4b4b4]">{ALBUM_EXPLAINER}</p>
        {error && (
          <p role="alert" className="mt-2 text-base text-red-300">
            {error}
          </p>
        )}
      </form>
    </SheetShell>
  );
}
