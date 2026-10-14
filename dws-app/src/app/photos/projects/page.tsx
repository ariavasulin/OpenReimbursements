"use client";

import { useMemo } from "react";
import { useCollectionSelect } from "@/hooks/use-collection-select";
import { useQueryClient } from "@tanstack/react-query";
import { Briefcase, Plus } from "lucide-react";
import CollectionCard from "@/components/photos/collection-card";
import CollectionSelectBar from "@/components/photos/collection-select-bar";
import ConfirmDialog from "@/components/photos/confirm-dialog";
import CollectionTitleRow from "@/components/photos/collection-sort-chip";
import EmptyState, { emptyPrimary } from "@/components/photos/empty-state";
import { PAGE_MAIN_CLASS } from "@/components/photos/page-layout";
import PhoneHeader from "@/components/photos/phone-header";
import { usePhotosShell } from "@/components/photos/photos-shell-context";
import RenameSheet from "@/components/photos/rename-sheet";
import StatusLine from "@/components/photos/status-line";
import { deleteJob, invalidatePhotoCaches, renameJob, usePhotoActor, usePhotoJobs } from "@/lib/photos/api";
import { isPhotoAdmin } from "@/lib/photos/permissions";
import { plural } from "@/lib/photos/format";
import { DEFAULT_JOB_SORT, JOB_SORT_OPTIONS, parseJobSort, sortJobs } from "@/lib/photos/collection-sort";
import { useCollectionSort } from "@/hooks/use-collection-sort";

/** Projects: every project as a card, in the order the Sort chip says (job number, newest first, by default); select (hover tick or press and hold) to rename or delete. New project lives in the "+" menu. */
export default function ProjectsPage() {
  const queryClient = useQueryClient();
  const { openNewProject } = usePhotosShell();
  const loaded = usePhotoJobs(true);
  const [sort, setSort] = useCollectionSort(parseJobSort, DEFAULT_JOB_SORT);
  const jobs = useMemo(() => loaded.data && sortJobs(loaded.data, sort), [loaded.data, sort]);
  const { isLoading, error } = loaded;
  // Deleting a project trashes every photo in it: photo admins only.
  const admin = isPhotoAdmin(usePhotoActor());
  const select = useCollectionSelect(jobs, {
    noun: "project",
    deleteOne: deleteJob,
    deletedDescription: "You can restore them from Trash for 30 days.",
    canDelete: () => admin,
  });
  const { chosen, deletable } = select;
  const chosenPhotos = deletable.reduce((sum, job) => sum + job.photo_count, 0);
  const them = deletable.length === 1 ? "it" : "them";

  const newProjectButton = (
    <button type="button" onClick={openNewProject} className={emptyPrimary}>
      <Plus className="h-5 w-5" aria-hidden="true" />
      New project
    </button>
  );

  return (
    <main className={PAGE_MAIN_CLASS}>
      <PhoneHeader />
      <CollectionTitleRow title="Projects" options={JOB_SORT_OPTIONS} value={sort} onChange={setSort} />

      {isLoading && <StatusLine>Loading projects...</StatusLine>}
      {error && (
        <StatusLine error>
          {error instanceof Error ? error.message : "Failed to load projects"}
        </StatusLine>
      )}
      {jobs && jobs.length === 0 && (
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
            selection={select.card(job.id)}
          />
        ))}
      </div>

      {select.selecting && (
        <CollectionSelectBar
          label="Selected projects"
          count={chosen.length}
          deletable={deletable.length}
          offerDelete={admin}
          busy={select.busy}
          onClose={select.stop}
          onRename={() => select.setRenaming(true)}
          onDelete={() => select.setConfirming(true)}
        />
      )}

      {chosen.length === 1 && (
        <RenameSheet
          open={select.renaming}
          onOpenChange={select.setRenaming}
          title="Rename project"
          nameLabel="Project name"
          name={chosen[0].name}
          number={chosen[0].job_number}
          onSave={async (name, number) => {
            await renameJob(chosen[0].id, name, number);
            invalidatePhotoCaches(queryClient);
            select.stop();
          }}
        />
      )}

      <ConfirmDialog
        open={select.confirming}
        onOpenChange={select.setConfirming}
        title={
          deletable.length === 1
            ? `Delete project “${deletable[0].name}”?`
            : `Delete ${plural(deletable.length, "project")}?`
        }
        confirmLabel="Delete"
        busyLabel="Deleting..."
        busy={select.busy}
        onConfirm={() => void select.remove()}
      >
        <p>
          {chosenPhotos > 0
            ? `${plural(chosenPhotos, "photo")} in ${them} will go to Trash too.`
            : `There are no photos in ${them}.`}
        </p>
        <p>You can restore from Trash for 30 days.</p>
      </ConfirmDialog>
    </main>
  );
}
