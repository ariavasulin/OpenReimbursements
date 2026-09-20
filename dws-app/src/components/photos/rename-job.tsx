"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { invalidatePhotoCaches, renameJob } from "@/lib/photos/api";

/** Inline rename for a project's heading. The job number never changes. */
export default function RenameJob({ jobId, name }: { jobId: string; name: string }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (draft === null) {
    return (
      <button type="button" onClick={() => setDraft(name)}
        className="ml-2 text-xs font-normal text-[#8bbaff] underline">
        Rename
      </button>
    );
  }
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await renameJob(jobId, draft);
      invalidatePhotoCaches(queryClient);
      setDraft(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Failed to rename the project");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="mt-2 flex flex-wrap items-center gap-2 text-sm font-normal"
      onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <input aria-label="Project name" autoFocus value={draft} maxLength={120} disabled={busy}
        onChange={(event) => setDraft(event.target.value)}
        className="min-w-0 flex-1 rounded-lg border border-[#3e3e3e] bg-[#3e3e3e] px-3 py-2 text-white focus:border-[#2680FC] focus:outline-none" />
      <button type="submit" disabled={busy || !draft.trim() || draft.trim() === name}
        className="rounded-lg bg-[#2680FC] px-3 py-2 text-white disabled:opacity-50">Save</button>
      <button type="button" disabled={busy} onClick={() => { setDraft(null); setError(""); }}
        className="px-2 py-2 text-[#b4b4b4] hover:text-white">Cancel</button>
      {error && <p role="alert" className="w-full text-xs text-red-300">{error}</p>}
    </form>
  );
}
