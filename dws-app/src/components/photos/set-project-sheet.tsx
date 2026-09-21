"use client";

import { useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import JobField from "@/components/photos/job-combobox";
import SheetShell from "@/components/photos/sheet-shell";
import { createActionBatch, usePhotoJobs } from "@/lib/photos/api";
import { NO_PROJECT, plural } from "@/lib/photos/format";
import { cn } from "@/lib/utils";

// "Set project" for one photo (the viewer) or many (the selection bar): choose
// a project, or "No project". Nothing changes here — it prepares the change and
// opens the confirm page, which shows exactly these photos before anything moves.

type Choice = "project" | "none";

export default function SetProjectSheet({
  photoIds,
  open,
  onOpenChange,
  onContinue,
}: {
  photoIds: string[];
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Fired just before leaving for the confirm page. */
  onContinue?(): void;
}) {
  const router = useRouter();
  const groupId = useId();
  const { data: jobs, isLoading } = usePhotoJobs(open);
  const [choice, setChoice] = useState<Choice>("project");
  const [jobId, setJobId] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setChoice("project");
      setJobId("");
    }
  }, [open]);

  const ready = choice === "none" || Boolean(jobId);

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    try {
      const batchId = await createActionBatch({
        action: "move",
        photoIds,
        destinationJobId: choice === "none" ? null : jobId,
      });
      onContinue?.();
      onOpenChange(false);
      router.push(`/photos/actions?batch=${encodeURIComponent(batchId)}`);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "Could not start that. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const option = (value: Choice, title: string, detail: string) => (
    <label
      className={cn(
        "flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5",
        choice === value ? "border-[#2680FC] bg-[#2680FC]/10" : "border-[#4e4e4e]"
      )}
    >
      <input
        type="radio"
        name={groupId}
        checked={choice === value}
        disabled={busy}
        onChange={() => setChoice(value)}
        className="mt-1 h-4 w-4 shrink-0 accent-[#2680FC]"
      />
      <span className="min-w-0">
        <span className="block text-base text-white">{title}</span>
        <span className="block text-base text-[#b4b4b4]">{detail}</span>
      </span>
    </label>
  );

  return (
    <SheetShell
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        onOpenChange(next);
      }}
      title={`Set project for ${plural(photoIds.length, "photo")}`}
      footer={
        <Button
          onClick={() => void submit()}
          disabled={!ready || busy}
          className="h-auto min-h-11 w-full bg-[#2680FC] py-2.5 text-base text-white hover:bg-[#1a6fd8]"
          size="lg"
        >
          {busy ? "One moment..." : "Continue"}
        </Button>
      }
    >
      <div role="radiogroup" aria-label="Project" className="space-y-2">
        {option("project", "A project", "The job these photos belong to.")}
        {choice === "project" && (
          <div className="pl-1 pt-1">
            <label htmlFor={`${groupId}-project`} className="mb-1.5 block text-base font-medium text-[#d0d0d0]">
              Which project?
            </label>
            <JobField
              inputId={`${groupId}-project`}
              jobs={jobs ?? []}
              jobsLoading={isLoading}
              value={jobId}
              onChange={setJobId}
              disabled={busy}
            />
          </div>
        )}
        {option(
          "none",
          NO_PROJECT,
          "The photos stay in Photos and in their albums. They just belong to no project."
        )}
      </div>
      <p className="mt-3 text-base text-[#b4b4b4]">
        Next you will see the photos and confirm. Nothing changes until then.
      </p>
    </SheetShell>
  );
}
