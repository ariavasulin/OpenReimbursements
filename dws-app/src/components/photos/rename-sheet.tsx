"use client";

import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import SheetShell from "@/components/photos/sheet-shell";

const inputClass =
  "min-h-11 w-full rounded-lg border border-[#3e3e3e] bg-[#3e3e3e] px-3 py-2.5 text-base text-white placeholder:text-[#b4b4b4] focus:border-[#2680FC] focus:outline-none";

/**
 * Rename one album, project, or photo. A project also shows its number, which
 * can be changed too; `onSave` throws with a message to show. A photo's name may
 * be left empty (`allowEmpty`) to go back to its uploaded filename.
 */
export default function RenameSheet({
  open,
  onOpenChange,
  title,
  nameLabel,
  name,
  number,
  onSave,
  allowEmpty = false,
  maxLength = 120,
  hint,
  loading = false,
  loadError,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  nameLabel: string;
  name: string;
  /** Projects only: the current number. */
  number?: string;
  onSave(name: string, number?: string): Promise<void>;
  allowEmpty?: boolean;
  maxLength?: number;
  /** A line under the name field. */
  hint?: string;
  /** The current name is still loading: the field waits. */
  loading?: boolean;
  /** The current name could not be loaded. */
  loadError?: string;
}) {
  const nameId = useId();
  const numberId = useId();
  const [nameDraft, setName] = useState(name);
  const [numberDraft, setNumber] = useState(number ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) {
      setName(name);
      setNumber(number ?? "");
      setError("");
    }
  }, [open, name, number]);

  const changed =
    nameDraft.trim() !== name || (number !== undefined && numberDraft.trim() !== number);
  const canSave =
    !busy && !loading && !loadError && (allowEmpty || nameDraft.trim() !== "") &&
    (number === undefined || numberDraft.trim() !== "") && changed;
  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    setError("");
    try {
      await onSave(nameDraft.trim(), number === undefined ? undefined : numberDraft.trim());
      onOpenChange(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Failed to rename");
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
      title={title}
      footer={
        <Button
          onClick={() => void save()}
          disabled={!canSave}
          className="h-auto min-h-11 w-full bg-[#2680FC] py-2.5 text-base text-white hover:bg-[#1a6fd8]"
          size="lg"
        >
          {busy ? "Saving..." : "Save"}
        </Button>
      }
    >
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div>
          <label htmlFor={nameId} className="mb-1.5 block text-base font-medium text-[#d0d0d0]">
            {nameLabel}
          </label>
          <input id={nameId} autoFocus value={loading ? "" : nameDraft} maxLength={maxLength} disabled={busy || loading || Boolean(loadError)}
            placeholder={loading ? "Loading..." : undefined}
            onChange={(event) => setName(event.target.value)} className={inputClass} />
          {hint && <p className="mt-1.5 text-sm text-[#b4b4b4]">{hint}</p>}
        </div>
        {number !== undefined && (
          <div>
            <label htmlFor={numberId} className="mb-1.5 block text-base font-medium text-[#d0d0d0]">
              Project number
            </label>
            <input id={numberId} value={numberDraft} maxLength={32} disabled={busy}
              onChange={(event) => setNumber(event.target.value)} className={inputClass} />
          </div>
        )}
        {/* A submit button lets Enter save from either field. */}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
        {(loadError || error) && (
          <p role="alert" className="text-base text-red-300">
            {loadError || error}
          </p>
        )}
      </form>
    </SheetShell>
  );
}
