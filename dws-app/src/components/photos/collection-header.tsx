"use client";

import { useState, type ReactNode } from "react";
import { Pencil } from "lucide-react";
import { PAGE_SUBTITLE_CLASS, PAGE_TITLE_CLASS } from "@/components/photos/page-layout";

/** A quiet 44px header action (Rename, Delete album, and Share). */
export const headerActionClass =
  "flex min-h-11 items-center gap-2 rounded-lg border border-[#4e4e4e] bg-[#2e2e2e] px-3 text-sm font-medium text-white hover:border-[#2680FC] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2680FC] disabled:opacity-50";

/**
 * The top of an album page and a project page: the name (wrapping, never cut),
 * a labeled count line, rename in place, and the page's actions.
 */
export default function CollectionHeader({
  name,
  fallbackName,
  subtitle,
  renameLabel,
  onRename,
  share,
  actions,
}: {
  /** undefined while loading. */
  name: string | undefined;
  fallbackName: string;
  subtitle: string;
  /** Accessible name of the rename field: "Album name" / "Project name". */
  renameLabel: string;
  /** Throws with a message to show under the field. */
  onRename(name: string): Promise<void>;
  /** Sharing control before Rename. */
  share?: ReactNode;
  /** Buttons after Rename (the album page's Delete album). */
  actions?: ReactNode;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const save = async () => {
    if (draft === null) return;
    setBusy(true);
    setError("");
    try {
      await onRename(draft.trim());
      setDraft(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Failed to rename");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-3">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-64">
          <h1 className={PAGE_TITLE_CLASS}>{name ?? fallbackName}</h1>
          <p className={PAGE_SUBTITLE_CLASS}>{subtitle}</p>
        </div>
        {name !== undefined && draft === null && (
          <div className="flex flex-wrap items-center gap-2">
            {share}
            <button type="button" onClick={() => setDraft(name)} className={headerActionClass}>
              <Pencil className="h-4 w-4" aria-hidden="true" />
              Rename
            </button>
            {actions}
          </div>
        )}
      </div>

      {draft !== null && (
        <form
          className="mt-3 flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <input
            aria-label={renameLabel}
            autoFocus
            value={draft}
            maxLength={120}
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
            className="min-h-11 min-w-0 flex-1 basis-56 rounded-lg border border-[#3e3e3e] bg-[#3e3e3e] px-3 text-base text-white focus:border-[#2680FC] focus:outline-none"
          />
          <button
            type="submit"
            disabled={busy || !draft.trim() || draft.trim() === name}
            className="min-h-11 rounded-lg bg-[#2680FC] px-4 text-base font-medium text-white disabled:opacity-50"
          >
            Save
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setDraft(null);
              setError("");
            }}
            className="min-h-11 rounded-lg px-3 text-base text-[#d0d0d0] hover:text-white"
          >
            Cancel
          </button>
          {error && (
            <p role="alert" className="w-full text-sm text-red-300">
              {error}
            </p>
          )}
        </form>
      )}
    </div>
  );
}
