"use client";

import { useRef, useState, type ReactNode } from "react";
import { Ellipsis, Pencil, Trash2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { menuClass, menuItemClass } from "@/components/photos/filter-bar";
import { cn } from "@/lib/utils";

/**
 * A page action in the header (Play, Share, Arrange, Rename, Delete). On a
 * phone it is one even tile of the action row, icon over label; at desktop the
 * same button is a 44px bordered button, icon beside label. Icons are sized
 * here, so each caller's own icon size does not matter.
 */
export const headerActionClass =
  "flex min-h-14 min-w-0 flex-col items-center justify-center gap-1 rounded-xl border border-[#4e4e4e] bg-[#2e2e2e] px-2 py-1.5 text-sm font-medium text-white hover:border-[#2680FC] hover:bg-[#3a3a3a] active:bg-[#3a3a3a] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2680FC] disabled:opacity-50 [&_svg]:size-5 [&_svg]:shrink-0 desktop:min-h-11 desktop:flex-row desktop:gap-2 desktop:rounded-lg desktop:px-3 desktop:py-0 desktop:text-base desktop:[&_svg]:size-4";

/**
 * The top of an album page and a project page: the name, a count line under
 * it, and the page's actions. On a phone the name is clamped to two lines (a
 * tap shows it whole; Rename shows it too) and the actions are one row of even
 * tiles — the page's own, then "More" holding Rename and Delete. At desktop
 * the name and actions sit side by side and Rename and Delete are buttons.
 */
export default function CollectionHeader({
  name,
  fallbackName,
  subtitle,
  renameLabel,
  number,
  onRename,
  actions,
  remove,
}: {
  /** undefined while loading. */
  name: string | undefined;
  fallbackName: string;
  subtitle: string;
  /** Accessible name of the rename field: "Album name" / "Project name". */
  renameLabel: string;
  /** A project's number: Rename then edits it too, and passes it to onRename. */
  number?: string;
  /** Throws with a message to show under the field. */
  onRename(name: string, number?: string): Promise<void>;
  /** The page's own actions, before Rename: Play, Share, Arrange. Style them with headerActionClass. */
  actions?: ReactNode;
  /** Delete album / Delete project, for those allowed: a button at desktop, in More on a phone. */
  remove?: { label: string; onSelect(): void };
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [numberDraft, setNumberDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [nameOpen, setNameOpen] = useState(false);
  // A pick from More hands focus on (to the rename field, or the delete
  // question) instead of back to the More button.
  const picked = useRef(false);
  const unchanged =
    draft !== null && draft.trim() === name && (number === undefined || numberDraft.trim() === number);

  const startRename = () => {
    if (name === undefined) return;
    setDraft(name);
    setNumberDraft(number ?? "");
  };

  const save = async () => {
    if (draft === null) return;
    setBusy(true);
    setError("");
    try {
      await onRename(draft.trim(), number === undefined ? undefined : numberDraft.trim());
      setDraft(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Failed to rename");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-4 desktop:mb-3">
      <div className="flex flex-col gap-3 desktop:flex-row desktop:flex-wrap desktop:items-start desktop:justify-between desktop:gap-x-4 desktop:gap-y-2">
        <div className="min-w-0 desktop:flex-1 desktop:basis-64">
          <h1
            onClick={() => setNameOpen((open) => !open)}
            className={cn(
              "break-words text-lg font-semibold leading-snug text-white desktop:line-clamp-none desktop:text-xl",
              !nameOpen && "line-clamp-2"
            )}
          >
            {name ?? fallbackName}
          </h1>
          <p className="mt-0.5 text-sm text-[#b4b4b4] desktop:mt-1 desktop:text-base">{subtitle}</p>
        </div>
        {name !== undefined && draft === null && (
          <div className="grid max-w-md auto-cols-fr grid-flow-col gap-2 desktop:flex desktop:max-w-none desktop:flex-wrap desktop:items-center">
            {actions}
            <button type="button" onClick={startRename} className={cn(headerActionClass, "hidden desktop:flex")}>
              <Pencil aria-hidden="true" />
              Rename
            </button>
            {remove && (
              <button type="button" onClick={remove.onSelect} className={cn(headerActionClass, "hidden desktop:flex")}>
                <Trash2 aria-hidden="true" />
                {remove.label}
              </button>
            )}
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <button type="button" className={cn(headerActionClass, "desktop:hidden")}>
                  <Ellipsis aria-hidden="true" />
                  More
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                collisionPadding={16}
                className={cn("min-w-52", menuClass)}
                onCloseAutoFocus={(event) => {
                  if (picked.current) event.preventDefault();
                  picked.current = false;
                }}
              >
                <DropdownMenuItem
                  className={cn(menuItemClass, "gap-3 [&_svg]:size-5")}
                  onSelect={() => {
                    picked.current = true;
                    startRename();
                  }}
                >
                  <Pencil aria-hidden="true" />
                  Rename
                </DropdownMenuItem>
                {remove && (
                  <DropdownMenuItem
                    className={cn(menuItemClass, "gap-3 [&_svg]:size-5")}
                    onSelect={() => {
                      picked.current = true;
                      remove.onSelect();
                    }}
                  >
                    <Trash2 aria-hidden="true" />
                    {remove.label}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>

      {draft !== null && (
        <form
          className="mt-3 flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <input
            aria-label={renameLabel}
            autoFocus
            value={draft}
            maxLength={120}
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
            className="min-h-11 min-w-0 flex-1 basis-56 rounded-lg border border-[#3e3e3e] bg-[#3e3e3e] px-3 text-base text-white focus:border-[#2680FC] focus:outline-none"
          />
          {number !== undefined && (
            <input
              aria-label="Project number"
              placeholder="Project number"
              value={numberDraft}
              maxLength={32}
              disabled={busy}
              onChange={(event) => setNumberDraft(event.target.value)}
              className="min-h-11 w-40 rounded-lg border border-[#3e3e3e] bg-[#3e3e3e] px-3 text-base text-white placeholder:text-[#b4b4b4] focus:border-[#2680FC] focus:outline-none"
            />
          )}
          <button
            type="submit"
            disabled={busy || !draft.trim() || (number !== undefined && !numberDraft.trim()) || unchanged}
            className="min-h-11 rounded-lg bg-[#2680FC] px-4 text-base font-medium text-white disabled:opacity-50"
          >
            Save
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setDraft(null);
              setError("");
            }}
            className="min-h-11 rounded-lg px-3 text-base text-[#d0d0d0] hover:text-white"
          >
            Cancel
          </button>
          {error && (
            <p role="alert" className="w-full text-sm text-red-300">
              {error}
            </p>
          )}
        </form>
      )}
    </div>
  );
}
