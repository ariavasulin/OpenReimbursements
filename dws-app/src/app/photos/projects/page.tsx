"use client";

import { Briefcase } from "lucide-react";
import CollectionCard from "@/components/photos/collection-card";
import EmptyState from "@/components/photos/empty-state";
import { PROJECT_EXPLAINER } from "@/components/photos/new-album-sheet";
import {
  PAGE_MAIN_CLASS,
  PAGE_SUBTITLE_CLASS,
  PAGE_TITLE_CLASS,
} from "@/components/photos/page-layout";
import PhoneHeader from "@/components/photos/phone-header";
import StatusLine from "@/components/photos/status-line";
import { usePhotoJobs } from "@/lib/photos/api";

/** Projects: every project as a card. */
export default function ProjectsPage() {
  const { data: jobs, isLoading, error } = usePhotoJobs(true);

  return (
    <main className={PAGE_MAIN_CLASS}>
      <PhoneHeader />
      <h1 className={PAGE_TITLE_CLASS}>Projects</h1>
      <p className={`mb-4 ${PAGE_SUBTITLE_CLASS}`}>{PROJECT_EXPLAINER}</p>

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
        >
          A project appears here once it exists. You can make one while uploading:
          type its name in the Project box and choose “New project”.
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
          />
        ))}
      </div>
    </main>
  );
}
