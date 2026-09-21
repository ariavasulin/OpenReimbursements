"use client";

import { useParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Briefcase, Upload } from "lucide-react";
import CollectionHeader from "@/components/photos/collection-header";
import EmptyState, { emptyPrimary } from "@/components/photos/empty-state";
import { PAGE_MAIN_CLASS } from "@/components/photos/page-layout";
import PhoneHeader from "@/components/photos/phone-header";
import PhotoBrowser from "@/components/photos/photo-browser";
import { usePhotosShell } from "@/components/photos/photos-shell-context";
import { invalidatePhotoCaches, renameJob, usePhotoJobs } from "@/lib/photos/api";
import { plural } from "@/lib/photos/format";

const PINNED_TAG = "professional";

/** One project. The URL is unchanged, so every link already sent keeps working. */
export default function ProjectPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const queryClient = useQueryClient();
  const { openPicker } = usePhotosShell();

  // Always enabled: the shell holds the session guard, so this page only
  // renders once the session is ready.
  const { data: jobs } = usePhotoJobs(true);
  const job = jobs?.find((candidate) => candidate.id === jobId);

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
        // share={<ShareButton ... />}  <- the Share button goes here (photo-albums Phase 7)
        onRename={async (name) => {
          await renameJob(jobId, name);
          invalidatePhotoCaches(queryClient);
        }}
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
    </main>
  );
}
