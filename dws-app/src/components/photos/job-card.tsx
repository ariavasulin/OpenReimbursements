"use client";

import Link from "next/link";
import { plural } from "@/lib/photos/format";
import { publicUrl } from "@/lib/photos/urls";
import type { PhotoJobSummary } from "@/lib/photos/types";

export default function JobCard({ job }: { job: PhotoJobSummary }) {
  const thumbs = job.thumb_paths.slice(0, 4);
  const remainder = job.photo_count - thumbs.length;

  return (
    <Link
      href={`/photos/${job.id}`}
      className="block rounded-[10px] border border-[#4e4e4e] bg-[#2e2e2e] p-3 hover:border-[#2680FC]"
    >
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <div className="min-w-0 truncate text-[15px] font-semibold">
          <span className="text-[#2680FC]">#{job.job_number}</span>
          <span className="text-white"> · {job.name}</span>
        </div>
        <div className="shrink-0 text-xs text-[#a0a0a0]">
          {plural(job.photo_count, "photo")}
        </div>
      </div>
      {thumbs.length > 0 ? (
        <div className="flex gap-1.5">
          {thumbs.map((path, i) => (
            <div
              key={path}
              className="relative aspect-square flex-1 overflow-hidden rounded-md bg-[#3e3e3e]"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={publicUrl(path)}
                alt=""
                loading="lazy"
                className="h-full w-full object-cover"
              />
              {i === thumbs.length - 1 && remainder > 0 && (
                <div className="absolute inset-0 flex items-center justify-center rounded-md bg-black/55 text-[13px] font-semibold">
                  +{remainder}
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="text-xs text-[#7e7e7e]">
          {job.location ? `${job.location} · ` : ""}No photos yet
        </div>
      )}
    </Link>
  );
}
