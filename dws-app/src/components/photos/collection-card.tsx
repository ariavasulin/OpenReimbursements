"use client";

import Link from "next/link";
import { plural } from "@/lib/photos/format";
import { publicUrl } from "@/lib/photos/urls";

/**
 * One album or project in a list: its name (up to two lines, never cut to a
 * few words), a labeled count line, and its four newest thumbnails.
 */
export default function CollectionCard({
  href,
  name,
  detail,
  photoCount,
  thumbPaths,
  emptyText,
}: {
  href: string;
  name: string;
  /** Goes before the count, e.g. "Project #3612". */
  detail?: string;
  photoCount: number;
  /** Server caps at 4. */
  thumbPaths: string[];
  emptyText: string;
}) {
  const remainder = photoCount - thumbPaths.length;

  return (
    <Link
      href={href}
      title={name}
      className="block rounded-xl border border-[#3e3e3e] bg-[#2a2a2a] p-3 hover:border-[#2680FC] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2680FC]"
    >
      <div className="line-clamp-2 break-words text-base font-semibold leading-snug text-white">
        {name}
      </div>
      <div className="mb-2.5 mt-0.5 text-sm text-[#b4b4b4]">
        {detail ? `${detail} · ` : ""}
        {plural(photoCount, "photo")}
      </div>
      {thumbPaths.length > 0 ? (
        <div className="grid grid-cols-4 gap-1.5">
          {thumbPaths.map((path, index) => (
            <div
              key={path}
              className="relative aspect-square overflow-hidden rounded-md bg-[#3e3e3e]"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={publicUrl(path)}
                alt=""
                loading="lazy"
                className="h-full w-full object-cover"
              />
              {index === thumbPaths.length - 1 && remainder > 0 && (
                <div className="absolute inset-0 flex items-center justify-center rounded-md bg-black/55 text-sm font-semibold text-white">
                  +{remainder}
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="flex aspect-[4/1] items-center justify-center rounded-md border border-dashed border-[#4e4e4e] text-sm text-[#a0a0a0]">
          {emptyText}
        </div>
      )}
    </Link>
  );
}
