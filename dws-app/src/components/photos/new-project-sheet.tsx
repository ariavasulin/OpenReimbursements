"use client";

import NewJobForm from "@/components/photos/new-job-form";
import SheetShell from "@/components/photos/sheet-shell";
import { usePhotoJobs, type PhotoJobRef } from "@/lib/photos/api";
import type { PhotoJobSummary } from "@/lib/photos/types";

/**
 * "New project" from the "+" menu: the same form every other place uses to
 * make a project, in a pop-up. A number that already belongs to a project
 * stays as an error, as on the Projects page.
 */
export default function NewProjectSheet({
  open,
  onOpenChange,
  onDone,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** The new project, or the existing one chosen from "Already exists". */
  onDone(job: PhotoJobRef | Pick<PhotoJobSummary, "id" | "job_number" | "name">): void;
}) {
  const { data: jobs } = usePhotoJobs(open);

  return (
    <SheetShell open={open} onOpenChange={onOpenChange} title="New project">
      <NewJobForm
        jobs={jobs ?? []}
        refuseExisting
        inSheet
        onCancel={() => onOpenChange(false)}
        onDone={(job) => {
          onOpenChange(false);
          onDone(job);
        }}
      />
    </SheetShell>
  );
}
