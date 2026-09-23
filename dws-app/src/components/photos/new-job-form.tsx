"use client";

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createJob, invalidatePhotoCaches, type PhotoJobRef } from "@/lib/photos/api";
import { filterJobs } from "@/lib/photos/job-filter";
import type { PhotoJobSummary } from "@/lib/photos/types";

// Create a project by hand wherever a job is chosen. Existing jobs that match
// the typed name or number are listed first, so choosing one is easier than
// making a duplicate.

interface NewJobFormProps {
  /** Jobs to check the typed name and number against. */
  jobs: Pick<PhotoJobSummary, "id" | "job_number" | "name">[];
  initialName?: string;
  /** The created job, or the existing one the employee chose instead. */
  onDone(job: PhotoJobRef | Pick<PhotoJobSummary, "id" | "job_number" | "name">): void;
  onCancel(): void;
}

const input =
  "w-full rounded-lg border border-[#3e3e3e] bg-[#3e3e3e] px-3 py-2.5 text-base text-white placeholder:text-[#b4b4b4] focus:border-[#2680FC] focus:outline-none md:text-sm";

export default function NewJobForm({ jobs, initialName = "", onDone, onCancel }: NewJobFormProps) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(initialName);
  const [number, setNumber] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const matches = useMemo(() => {
    const byName = name.trim() ? filterJobs(jobs as PhotoJobSummary[], name, 3) : [];
    const byNumber = jobs.filter((job) => number.trim() && job.job_number === number.trim());
    return [...new Map([...byNumber, ...byName].map((job) => [job.id, job])).values()];
  }, [jobs, name, number]);

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await createJob({ name, ...(number.trim() ? { job_number: number } : {}) });
      invalidatePhotoCaches(queryClient);
      onDone(result.job);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Failed to create the project");
      setBusy(false);
    }
  };

  return (
    <div className="mb-3.5 space-y-2 rounded-lg border border-[#4e4e4e] p-3">
      <input aria-label="Project name" autoFocus value={name} maxLength={120} disabled={busy}
        onChange={(event) => setName(event.target.value)} placeholder="Project name" className={input} />
      <input aria-label="Project number (optional)" value={number} maxLength={32} disabled={busy}
        onChange={(event) => setNumber(event.target.value)} placeholder="Project number (optional)" className={input} />
      {!number.trim() && <p className="text-xs text-[#b4b4b4]">Leave it empty and the app gives the project a code like P-12.</p>}
      {matches.length > 0 && (
        <div className="text-xs text-[#b4b4b4]">
          Already exists:
          {matches.map((job) => (
            <button key={job.id} type="button" disabled={busy} onClick={() => onDone(job)}
              className="mt-1 block w-full truncate text-left text-sm text-[#8bbaff] underline">
              Use #{job.job_number} · {job.name}
            </button>
          ))}
        </div>
      )}
      {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
      <div className="flex gap-2">
        <button type="button" disabled={busy || !name.trim()} onClick={() => void submit()}
          className="rounded-lg bg-[#2680FC] px-3 py-2 text-sm text-white disabled:opacity-50">
          {busy ? "Creating..." : "Create project"}
        </button>
        <button type="button" disabled={busy} onClick={onCancel}
          className="rounded-lg px-3 py-2 text-sm text-[#b4b4b4] hover:text-white">
          Cancel
        </button>
      </div>
    </div>
  );
}
