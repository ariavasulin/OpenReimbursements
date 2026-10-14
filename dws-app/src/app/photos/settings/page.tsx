"use client";

import { useEffect, useId, useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { toast } from "sonner";
import { chipClass } from "@/components/photos/filter-bar";
import { fieldClass } from "@/components/photos/date-range-fields";
import { PAGE_TITLE_CLASS } from "@/components/photos/page-layout";
import { PHOTO_SETTINGS_KEY, savePhotoSettings, usePhotoActor, usePhotoSettings } from "@/lib/photos/api";
import { actionButton, actionPrimary } from "@/lib/photos/action-client";
import { isPhotoAdmin } from "@/lib/photos/permissions";
import { DEFAULT_SLIDESHOW, SLIDESHOW_DELAY_CHOICES, type PhotoSettingsPatch } from "@/lib/photos/settings";
import { appendTag, TAG_EXPLAINER } from "@/lib/photos/tags";

// Settings: the slideshow (each person's own: random order, seconds a photo
// stays) and, for photo admins, the default tags every tag picker offers.
// Reached from the account menu. Each change saves at once; the page shows
// what the server answered, so two tabs never disagree for long.

const sectionClass = "space-y-3 rounded-xl bg-[#2e2e2e] p-5";
const explainer = "text-base leading-relaxed text-[#bbb]";

export default function SettingsPage() {
  const queryClient = useQueryClient();
  const settings = usePhotoSettings();
  const admin = isPhotoAdmin(usePhotoActor());
  const [saving, setSaving] = useState(false);

  const save = async (patch: PhotoSettingsPatch, done: string) => {
    setSaving(true);
    try {
      const next = await savePhotoSettings(patch);
      queryClient.setQueryData(PHOTO_SETTINGS_KEY, next);
      toast.success(done);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "Could not save settings");
    } finally {
      setSaving(false);
    }
  };

  const slideshow = settings?.slideshow ?? DEFAULT_SLIDESHOW;
  const delayId = useId();

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-4 py-5 pb-40 sm:px-8">
      <Link href="/photos" className="desktop:hidden -ml-2 flex min-h-11 w-fit items-center gap-1 rounded-lg px-2 text-base font-medium text-[#8bbaff]">
        <span aria-hidden="true">&lsaquo;</span>DWS Photos
      </Link>
      <header className="space-y-2">
        <h1 className={PAGE_TITLE_CLASS}>Settings</h1>
      </header>

      <section aria-labelledby="slideshow-heading" className={sectionClass}>
        <h2 id="slideshow-heading" className="text-lg font-semibold">Slideshow</h2>
        <p className={explainer}>How Play runs for you, on every page. Nobody else&rsquo;s slideshow changes.</p>
        <div className="flex flex-wrap items-center gap-4">
          <button
            type="button"
            aria-pressed={slideshow.shuffle}
            disabled={!settings || saving}
            onClick={() => void save({ slideshow: { shuffle: !slideshow.shuffle } }, slideshow.shuffle ? "Slideshow plays in order" : "Slideshow plays in random order")}
            className={chipClass(slideshow.shuffle)}
          >
            Random order
          </button>
          <label htmlFor={delayId} className="flex items-center gap-2 text-base">
            <span className="whitespace-nowrap">Each photo stays</span>
            <select
              id={delayId}
              value={slideshow.delay_seconds}
              disabled={!settings || saving}
              onChange={(event) => void save({ slideshow: { delay_seconds: Number(event.target.value) } }, `Each photo stays ${event.target.value} seconds`)}
              className={`${fieldClass} w-auto`}
            >
              {SLIDESHOW_DELAY_CHOICES.map((seconds) => (
                <option key={seconds} value={seconds}>{seconds} seconds</option>
              ))}
            </select>
          </label>
        </div>
      </section>

      <section aria-labelledby="tags-heading" className={sectionClass}>
        <h2 id="tags-heading" className="text-lg font-semibold">Default tags</h2>
        <p className={explainer}>
          {TAG_EXPLAINER} These are offered everywhere tags are picked, even before any photo carries them.
          {admin ? "" : " A photo admin can change them."}
        </p>
        {settings && (
          <StarterTagsEditor
            key={settings.starter_tags.join("\n")}
            tags={settings.starter_tags}
            editable={admin}
            saving={saving}
            onSave={(starter_tags) => save({ starter_tags }, "Default tags saved")}
          />
        )}
      </section>
    </main>
  );
}

/** The default tag list as chips: a photo admin removes one with its ×, adds one from the field, then saves. */
function StarterTagsEditor({ tags, editable, saving, onSave }: {
  tags: string[];
  editable: boolean;
  saving: boolean;
  onSave(tags: string[]): Promise<void>;
}) {
  const [draft, setDraft] = useState(tags);
  const [input, setInput] = useState("");
  const inputId = useId();
  // Another tab (or the server's spelling) wins: a fresh list resets an untouched draft.
  useEffect(() => setDraft(tags), [tags]);
  const changed = draft.join("\n") !== tags.join("\n");
  const add = () => {
    setDraft((current) => appendTag(current, input));
    setInput("");
  };
  return (
    <div className="space-y-3">
      <ul className="flex flex-wrap gap-2" aria-label="Default tags">
        {draft.length === 0 && <li className="text-base text-[#bbb]">No default tags.</li>}
        {draft.map((tag) => (
          <li key={tag} className={chipClass(false)}>
            {tag}
            {editable && (
              <button
                type="button"
                aria-label={`Remove ${tag}`}
                disabled={saving}
                onClick={() => setDraft((current) => current.filter((have) => have !== tag))}
                className="-mr-1 ml-1 flex h-7 w-7 items-center justify-center rounded-full hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2680FC]"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            )}
          </li>
        ))}
      </ul>
      {editable && (
        <>
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(event) => { event.preventDefault(); add(); }}
          >
            <label htmlFor={inputId} className="block grow sm:max-w-xs">
              <span className="mb-1 block text-sm font-medium text-white">Add a default tag</span>
              <input id={inputId} value={input} maxLength={64} disabled={saving || draft.length >= 20}
                onChange={(event) => setInput(event.target.value)} className={fieldClass} placeholder="e.g. Install" />
            </label>
            <button type="submit" className={`${actionButton} min-h-11`} disabled={saving || !input.trim() || draft.length >= 20}>Add</button>
          </form>
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className={`${actionPrimary} min-h-11`} disabled={saving || !changed} onClick={() => void onSave(draft)}>Save default tags</button>
            {changed && <button type="button" className={`${actionButton} min-h-11`} disabled={saving} onClick={() => setDraft(tags)}>Undo changes</button>}
          </div>
          <p className="text-sm text-[#bbb]">Up to 20 tags. Changing the defaults does not change the tags photos already have.</p>
        </>
      )}
    </div>
  );
}
