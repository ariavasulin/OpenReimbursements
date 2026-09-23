"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Briefcase, CheckSquare, Plus } from "lucide-react";
import { toast } from "sonner";
import CollectionCard from "@/components/photos/collection-card";
import { headerActionClass } from "@/components/photos/collection-header";
import CollectionSelectBar from "@/components/photos/collection-select-bar";
import ConfirmDialog from "@/components/photos/confirm-dialog";
import EmptyState, { emptyPrimary } from "@/components/photos/empty-state";
import { PROJECT_EXPLAINER } from "@/components/photos/new-album-sheet";
import NewJobForm from "@/components/photos/new-job-form";
import {
  PAGE_MAIN_CLASS,
  PAGE_SUBTITLE_CLASS,
  PAGE_TITLE_CLASS,
} from "@/components/photos/page-layout";
import PhoneHeader from "@/components/photos/phone-header";
import RenameSheet from "@/components/photos/rename-sheet";
import StatusLine from "@/components/photos/status-line";
import { deleteJob, invalidatePhotoCaches, renameJob, usePhotoJobs } from "@/lib/photos/api";
import { plural } from "@/lib/photos/format";

/** Projects: every project as a card; New project; select to rename or delete. */
export default function ProjectsPage() {
  const queryClient = useQueryClient();
  const { data: jobs, isLoading, error } = usePhotoJobs(true);
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const chosen = (jobs ?? []).filter((job) => selected?.has(job.id));
  const chosenPhotos = chosen.reduce((sum, job) => sum + job.photo_count, 0);
  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const remove = async () => {
    setBusy(true);
    let deleted = 0;
    try {
      for (const job of chosen) {
        await deleteJob(job.id);
        deleted++;
      }
      toast.success(`${plural(deleted, "project")} deleted`, {
        description: "You can restore them from Trash for 30 days.",
      });
      setSelected(null);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "Failed to delete the project", {
        description: deleted > 0 ? `${plural(deleted, "project")} deleted before this.` : undefined,
      });
    } finally {
      invalidatePhotoCaches(queryClient);
      setBusy(false);
      setConfirming(false);
    }
  };

  const newProjectButton = (
    <button type="button" onClick={() => setCreating(true)} className={emptyPrimary}>
      <Plus className="h-5 w-5" aria-hidden="true" />
      New project
    </button>
  );

  return (
    <main className={PAGE_MAIN_CLASS}>
      <PhoneHeader />
      <div className="mb-4 flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <h1 className={PAGE_TITLE_CLASS}>Projects</h1>
          <p className={PAGE_SUBTITLE_CLASS}>{PROJECT_EXPLAINER}</p>
        </div>
        {jobs && jobs.length > 0 && selected === null && (
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => setSelected(new Set())} className={headerActionClass}>
              <CheckSquare className="h-4 w-4" aria-hidden="true" />
              Select
            </button>
            {newProjectButton}
          </div>
        )}
      </div>

      {creating && (
        <div className="mb-4 max-w-xl">
          <NewJobForm
            jobs={jobs ?? []}
            onCancel={() => setCreating(false)}
            onDone={(job) => {
              setCreating(false);
              toast.success(`Project #${job.job_number} · ${job.name} is ready`);
            }}
          />
        </div>
      )}

      {isLoading && <StatusLine>Loading projects...</StatusLine>}
      {error && (
        <StatusLine error>
          {error instanceof Error ? error.message : "Failed to load projects"}
        </StatusLine>
      )}
      {jobs && jobs.length === 0 && !creating && (
        <EmptyState
          icon={<Briefcase className="h-7 w-7" aria-hidden="true" />}
          title="No projects yet"
          actions={newProjectButton}
        >
          Make one here, or while uploading: type its name in the Project box and
          choose “New project”.
        </EmptyState>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {jobs?.map((job) => (
          <CollectionCard
            key={job.id}
            href={`/photos/${job.id}`}
            name={job.name}
            detail={`Project #${job.job_number}`}
            photoCount={job.photo_count}
            thumbPaths={job.thumb_paths}
            emptyText={job.location ? `${job.location} · No photos yet` : "No photos yet"}
            selection={selected ? { selected: selected.has(job.id), onToggle: () => toggle(job.id) } : undefined}
          />
        ))}
      </div>

      {selected && (
        <CollectionSelectBar
          label="Selected projects"
          count={chosen.length}
          busy={busy}
          onClose={() => setSelected(null)}
          onRename={() => setRenaming(true)}
          onDelete={() => setConfirming(true)}
        />
      )}

      {chosen.length === 1 && (
        <RenameSheet
          open={renaming}
          onOpenChange={setRenaming}
          title="Rename project"
          nameLabel="Project name"
          name={chosen[0].name}
          number={chosen[0].job_number}
          onSave={async (name, number) => {
            await renameJob(chosen[0].id, name, number);
            invalidatePhotoCaches(queryClient);
            setSelected(null);
          }}
        />
      )}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={
          chosen.length === 1
            ? `Delete project “${chosen[0].name}”?`
            : `Delete ${plural(chosen.length, "project")}?`
        }
        confirmLabel="Delete"
        busyLabel="Deleting..."
        busy={busy}
        onConfirm={() => void remove()}
      >
        <p>
          {chosenPhotos > 0
            ? `${plural(chosenPhotos, "photo")} in ${chosen.length === 1 ? "it" : "them"} will go to Trash too.`
            : "There are no photos in it."}
        </p>
        <p>You can restore from Trash for 30 days.</p>
      </ConfirmDialog>
    </main>
  );
}
