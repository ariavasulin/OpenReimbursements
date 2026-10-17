"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Briefcase, Upload } from "lucide-react";
import { toast } from "sonner";
import ShareButton from "@/components/photos/share-button";
import CollectionHeader, { headerActionClass } from "@/components/photos/collection-header";
import ConfirmDialog from "@/components/photos/confirm-dialog";
import EmptyState, { emptyPrimary, emptySecondary } from "@/components/photos/empty-state";
import { PAGE_MAIN_CLASS } from "@/components/photos/page-layout";
import PhoneHeader from "@/components/photos/phone-header";
import PhotoBrowser from "@/components/photos/photo-browser";
import { PlayButton, SlideshowLink } from "@/components/photos/slideshow-link";
import { usePhotosShell } from "@/components/photos/photos-shell-context";
import { deleteJob, invalidatePhotoCaches, renameJob, usePhotoActor, usePhotoJob } from "@/lib/photos/api";
import { isPhotoAdmin } from "@/lib/photos/permissions";
import { plural } from "@/lib/photos/format";

const PINNED_TAG = "Photoshoot";

/** One project. The URL is unchanged, so every link already sent keeps working. */
export default function ProjectPage() {
  // The header's Play button starts the viewer's slideshow (slideshow-link.tsx).
  return (
    <SlideshowLink>
      <ProjectPageContent />
    </SlideshowLink>
  );
}

function ProjectPageContent() {
  const { jobId } = useParams<{ jobId: string }>();
  // The ?photo= an old link arrived with, read once: the viewer rewrites it on
  // every swipe, and following those changes would redraw this whole page.
  // (Lazy initializers also run during SSR, hence the window guard.)
  const [linkedPhoto] = useState(() =>
    typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("photo")
  );
  const router = useRouter();
  const queryClient = useQueryClient();
  const { openPicker } = usePhotosShell();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Deleting a project trashes every photo in it: photo admins only.
  const canDelete = isPhotoAdmin(usePhotoActor());

  // Always enabled: the shell holds the session guard, so this page only
  // renders once the session is ready. Shown at once from the Projects list
  // when that is cached; otherwise this one project is read by itself.
  const { data: found } = usePhotoJob(jobId);
  const job = found ?? undefined;

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

  // Only active projects are found, so a deleted (or unknown) project's old
  // link lands here: say so, and never offer an upload into it. An older
  // /photos/<jobId>?photo=<id> link still opens its photo, wherever it is now.
  const deadLink = found === null;
  useEffect(() => {
    if (deadLink && linkedPhoto) router.replace(`/photos?photo=${encodeURIComponent(linkedPhoto)}`);
  }, [deadLink, linkedPhoto, router]);
  if (deadLink) {
    if (linkedPhoto) return <main className={PAGE_MAIN_CLASS} />;
    return (
      <main className={PAGE_MAIN_CLASS}>
        <PhoneHeader back={{ href: "/photos/projects", label: "Projects" }} />
        <EmptyState
          icon={<Briefcase className="h-7 w-7" aria-hidden="true" />}
          title="This project is not here"
          actions={
            <>
              <Link href="/photos/projects" className={emptyPrimary}>
                All projects
              </Link>
              <Link href="/photos/trash" className={emptySecondary}>
                Open Trash
              </Link>
            </>
          }
        >
          It may have been deleted. A deleted project can be restored from Trash for
          30 days, together with its photos.
        </EmptyState>
      </main>
    );
  }

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
        actions={
          job && (
            <>
              <PlayButton />
              <ShareButton project={{ id: job.id, name: job.name }} className={headerActionClass} />
            </>
          )
        }
        onRename={async (name, number) => {
          await renameJob(jobId, name, number);
          invalidatePhotoCaches(queryClient);
        }}
        remove={canDelete ? { label: "Delete project", onSelect: () => setConfirmingDelete(true) } : undefined}
      />

      <PhotoBrowser
        scope={{ kind: "job", jobId }}
        // A project opens grouped by tag: that is how the office sorts a job's
        // photos (Shop, Field, Photoshoot). The first mode is the default.
        groupModes={["tag", "date", "uploader", "type"] as const}
        pinnedTag={PINNED_TAG}
        pinnedLabel="Photoshoot"
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
