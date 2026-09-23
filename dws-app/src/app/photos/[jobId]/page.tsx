"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Briefcase, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import ShareButton from "@/components/photos/share-button";
import CollectionHeader, { headerActionClass } from "@/components/photos/collection-header";
import ConfirmDialog from "@/components/photos/confirm-dialog";
import EmptyState, { emptyPrimary } from "@/components/photos/empty-state";
import { PAGE_MAIN_CLASS } from "@/components/photos/page-layout";
import PhoneHeader from "@/components/photos/phone-header";
import PhotoBrowser from "@/components/photos/photo-browser";
import { usePhotosShell } from "@/components/photos/photos-shell-context";
import { deleteJob, invalidatePhotoCaches, renameJob, usePhotoJobs } from "@/lib/photos/api";
import { plural } from "@/lib/photos/format";

const PINNED_TAG = "professional";

/** One project. The URL is unchanged, so every link already sent keeps working. */
export default function ProjectPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { openPicker } = usePhotosShell();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Always enabled: the shell holds the session guard, so this page only
  // renders once the session is ready.
  const { data: jobs } = usePhotoJobs(true);
  const job = jobs?.find((candidate) => candidate.id === jobId);

  const remove = async () => {
    if (!job) return;
    setDeleting(true);
    try {
      const { trashed } = await deleteJob(job.id);
      invalidatePhotoCaches(queryClient);
      toast.success(`Project “${job.name}” deleted`, {
        description: `${trashed > 0 ? `${plural(trashed, "photo")} went to Trash with it. ` : ""}You can restore it from Trash for 30 days.`,
      });
      router.push("/photos/projects");
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "Failed to delete the project");
      setDeleting(false);
      setConfirmingDelete(false);
    }
  };

  return (
    <main className={PAGE_MAIN_CLASS}>
      <PhoneHeader back={{ href: "/photos/projects", label: "Projects" }} />
      <CollectionHeader
        name={job?.name}
        fallbackName="Project"
        subtitle={
          job
            ? [
                `Project #${job.job_number}`,
                plural(job.photo_count, "photo"),
                job.location,
              ]
                .filter(Boolean)
                .join(" · ")
            : " "
        }
        renameLabel="Project name"
        number={job?.job_number}
        share={job && <ShareButton project={{ id: job.id, name: job.name }} />}
        onRename={async (name, number) => {
          await renameJob(jobId, name, number);
          invalidatePhotoCaches(queryClient);
        }}
        actions={
          <button type="button" onClick={() => setConfirmingDelete(true)} className={headerActionClass}>
            <Trash2 className="h-4 w-4" aria-hidden="true" />
            Delete project
          </button>
        }
      />

      <PhotoBrowser
        scope={{ kind: "job", jobId }}
        pinnedTag={PINNED_TAG}
        pinnedLabel="Professional Photography"
        empty={
          <EmptyState
            icon={<Briefcase className="h-7 w-7" aria-hidden="true" />}
            title="No photos in this project yet"
            actions={
              <button type="button" onClick={openPicker} className={emptyPrimary}>
                <Upload className="h-5 w-5" aria-hidden="true" />
                Upload photos to this project
              </button>
            }
          >
            Photos you upload from here go into this project.
          </EmptyState>
        }
      />

      <ConfirmDialog
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        title={`Delete project “${job?.name ?? "Project"}”?`}
        confirmLabel="Delete project"
        busyLabel="Deleting..."
        busy={deleting}
        onConfirm={() => void remove()}
      >
        <p>
          {job && job.photo_count > 0
            ? `Its ${plural(job.photo_count, "photo")} will go to Trash too.`
            : "There are no photos in it."}
        </p>
        <p>You can restore the project, with its photos, from Trash for 30 days.</p>
      </ConfirmDialog>
    </main>
  );
}
