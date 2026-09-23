"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { Check } from "lucide-react";
import { plural } from "@/lib/photos/format";
import { publicUrl } from "@/lib/photos/urls";

/**
 * One album or project in a list: its name (up to two lines, never cut to a
 * few words), a labeled count line, and its four newest thumbnails. In select
 * mode (`selection` given) the card is a toggle instead of a link.
 */
export default function CollectionCard({
  href,
  name,
  detail,
  photoCount,
  thumbPaths,
  emptyText,
  selection,
}: {
  href: string;
  name: string;
  /** Goes before the count, e.g. "Project #3612". */
  detail?: string;
  photoCount: number;
  /** Server caps at 4. */
  thumbPaths: string[];
  emptyText: string;
  selection?: { selected: boolean; onToggle(): void };
}) {
  const remainder = photoCount - thumbPaths.length;
  const cardClass =
    "block w-full rounded-xl border bg-[#2a2a2a] p-3 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2680FC]";

  const body: ReactNode = (
    <>
      <div className="flex items-start gap-2">
        <div className="line-clamp-2 min-w-0 flex-1 break-words text-base font-semibold leading-snug text-white">
          {name}
        </div>
        {selection && (
          <span
            aria-hidden="true"
            className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 ${
              selection.selected ? "border-[#2680FC] bg-[#2680FC]" : "border-[#8e8e8e]"
            }`}
          >
            {selection.selected && <Check className="h-4 w-4 text-white" />}
          </span>
        )}
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
    </>
  );

  if (selection) {
    return (
      <button
        type="button"
        aria-pressed={selection.selected}
        aria-label={`Select ${name}`}
        onClick={selection.onToggle}
        className={`${cardClass} ${selection.selected ? "border-[#2680FC]" : "border-[#3e3e3e] hover:border-[#8e8e8e]"}`}
      >
        {body}
      </button>
    );
  }
  return (
    <Link href={href} title={name} className={`${cardClass} border-[#3e3e3e] hover:border-[#2680FC]`}>
      {body}
    </Link>
  );
}
