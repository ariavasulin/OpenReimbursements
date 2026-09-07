# Photos Runbook

Operational notes for the DWS Photos hub (uploads, confirmed changes, repair sweep).

For hosted assistant configuration, shared-key rotation, photo handoffs, and
confirmed issue submission recovery, see the [DWS MCP runbook](dws-mcp-runbook.md).

## Confirmed photo changes and trash

Move a photo through its review/confirmation screen. Direct `PATCH job_id`
writes are rejected; sheet and tag edits apply only to active photos. Any
signed-in employee can move a photo. Ordinary removal and restoration require
the uploader or an administrator; a consumed MCP handoff authorizes only its
bound consumer, action, and confirmed targets.

Removal sends a photo to `/photos/trash` for 30 days. Repeating removal does
not extend its original `purge_after`; restoration is unavailable at or after
that timestamp, even if permanent cleanup has not run. The public bucket is
unchanged: someone with a known object URL can still fetch it during retention.
Library listings, search, counts, tags, and deep links exclude all trash.

A legacy duplicate in trash points to its canonical photo. Review the canonical
target before restoring or moving it; restoration never creates another active
copy. Uploading matching bytes keeps the item unresolved until that action
succeeds or the employee explicitly skips it. An employee who cannot restore
the matching photo should ask an administrator or use an MCP restore handoff,
then retry the original queue item to resolve the canonical result.

## Legacy standalone-sidecar audit

`node dws-app/scripts/attach-orphan-sidecars.mjs` is read-only and considers
active rows only. Its `--execute` / `-x` mode is retired and fails before any
network request. The historical one-time mutation needed to precede cutover;
it bypassed the confirmed-action gate and hard-deleted standalone rows. Normal
intake now pairs XMP sidecars, so the new application has no need for this legacy
writer. Keep the audit for identifying historical candidates without modifying
rows or Storage objects.

## Repair sweep (`/api/photos/repair`)

A daily Vercel cron (09:00 UTC, `vercel.json`) first permanently purges up to
500 expired photos, then repairs active photos and cleans orphan objects.
Both GET and POST require `CRON_SECRET` and the server-only
`photo_release_state.repair_enabled` gate with schema generation 1. An absent
or closed gate returns 503 before any lease or Storage mutation.

One 240-second deadline starts at handler entry and covers purge, discovery,
network body reads, image transforms, and ffmpeg. Each control request also
has a 15-second timeout; ffmpeg is killed when the shared deadline or lease
cancellation fires. The final ten seconds are reserved only for backlog
reporting and lease release, inside the 300-second function limit.

### Run it by hand

```sh
curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
  https://photos.dws-receipts.com/api/photos/repair
```

`CRON_SECRET` is the Vercel environment variable of the same name. The
response looks like:

```json
{
  "counts": { "fillImageDerivatives": 2 }, "errors": [], "error_count": 0, "planned": 2,
  "purged": 3, "purge_failed": 0, "purge_backlog": 0,
  "work_deferred": 0, "oldest_due_at": null
}
```

### What each `counts` key means

| Key | What happened |
| --- | --- |
| `fillImageDerivatives` | An image row had no thumbnail (client couldn't decode it — e.g. HEIC picked in Chrome). The sweep rendered a thumb + preview via Supabase image transforms and filled the row. |
| `markFileTile` | An image couldn't be transformed (RAW format, or original over 25 MB, or the transform endpoint refused it). The row was set to `kind='file'` — a deliberate file tile, not a hole. Check the log line for the reason. |
| `makeVideoPoster` | A video row had no poster. The sweep downloaded the original, extracted a frame with ffmpeg (~1 s in), uploaded it as thumb + preview WebPs, and recorded `duration_secs`. |
| `transcodeVideo` | A video within the caps gained an H.264/AAC `playback_path` rendition (`derived/{uid}/{photoId}_playback.mp4`). Only planned when `PHOTOS_TRANSCODE=1`. |
| `posterSkipped` | A video exceeds the server poster processing cap. The persistent `poster_skipped_reason` explains the skip; its original and video kind are retained. |
| `playbackSkipped` | A planned transcode found the clip over a cap and set `playback_skipped_reason` instead. The sweep never replans it; the lightbox shows the download card. |
| `transcodeDeferred` | A video reached the shared work deadline. Completed poster work remains counted; unfinished work resumes on a later invocation. |
| `deleteOrphanObject` | An old object under `originals/` or `derived/` had no current retained-photo or upload-attempt owner. SQL authorizes its deletion and fences later path reuse; Storage confirms its absence. |
| `deleteDeadRow` | An active `photos` row's original object is missing from storage — finalize raced a dead upload. Row deleted. |

`errors` samples at most 50 failures, with at most 1,000 characters each.
`error_count` is the exact failure count even when details are truncated.
Action failures are isolated; a lost lease stops the run immediately. Rows younger
than 10 minutes are always skipped — the client may still be uploading its
derivatives.

**A run with any error responds `500`.** The original `counts`, `errors`,
and `planned` fields remain. `purged` counts rows actually removed;
`purge_failed` counts attempted photos with cleanup failures. `purge_backlog`
and `oldest_due_at` describe the remaining expired rows, including canonicals
held by duplicate references. A null backlog means it could not be measured
(for example, another invocation owns the lease); it does not mean zero.
`work_deferred` counts known interrupted items, with at least one when a scan
remains unfinished. It is a lower bound, not a full unscanned-corpus count.
Ordinary budget exhaustion and a busy lease return 200 with visible deferral.
A failed cron shows red under **Settings → Cron Jobs**. A `400` instead means
the request itself was bad (an unparseable `?olderThan=`); nothing was swept.

### `?olderThan=<ms>` (drills only)

For a drill (verify a killed upload's object gets swept), override the 24 h
orphan age on a manual run:

```sh
curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
  "https://photos.dws-receipts.com/api/photos/repair?olderThan=0"
```

This override changes only orphan age, never the 30-day retention deadline
or upload ownership checks. Use an isolated fixture target for destructive
drills; do not run them against the production corpus.

### Recovery after failure, overlap, or process death

Save the response when invoking repair, inspect `errors`, and rerun the same
POST after fixing the reported dependency. Vercel cron does not automatically
retry a failed run. Storage deletion is idempotent: a missing object is already
clean, while a failed or partial delete retains the photo row and original
`purge_after`. The next run retries the remaining recorded paths. Shared paths
remain while another retained photo or protected attempt owns them. Expired
duplicate rows drain before their canonical row; a surviving duplicate
reference holds that canonical for a later run. Completed migration and action
histories do not block deletion; their audit identifiers survive.

The singleton `photo_repair_progress` lease lasts two minutes and renews every
30 seconds. An overlapping invocation performs no repair work. If the process
dies, wait for lease expiry and rerun; never manually clear a live lease.
Generation checks fence stale workers. Photo and Storage scans alternate
100-entry keyset pages and checkpoint completed items; a failed item may replay
on the next scan cycle. No whole-library list is loaded or persisted as an
ownership snapshot. A partial scan never proves that an object is unowned.

Read progress using an operator database session:

```sql
select lease_holder, lease_generation, lease_expires_at,
       photo_cursor, storage_cursor, updated_at
from public.photo_repair_progress where singleton;
```

Unfinished ordinary and migration attempts remain owners after lease expiry
so closing a tab does not lose resumable bytes. Explicit ordinary queue Remove
must durably cancel its unfinished attempt before dropping the queue item;
cancelled migration items and explicit skips likewise become eligible after
the orphan age. Completed photos remain retained owners. Deletion authorization
stores permanent path fences in `photo_repair_deleted_paths`; never erase those
records to retry an upload. A retired path requires a new attempt/photo UUID.
Upload ledgers and `photo_repair_retired_ids` prevent reuse across owners.

During production cutover, disable Vercel cron, stop manual repair, drain the
last old invocation for its completion or 300 seconds, then deploy the complete
new handler with the repair gate closed. Verify both methods return 503 before
cleanup. Re-enable the gate only after the new schema/app cutover succeeds;
record one manual repair, re-enable cron, and record the first scheduled result.
Code rollback alone cannot safely run the old service-role repair over trash.
Keep these activation obligations in the release checklist until observed.

### Video transcoding (`PHOTOS_TRANSCODE`)

The H.264 playback rendition is behind the `PHOTOS_TRANSCODE` Vercel env
var — set it to `1` to turn transcoding on; unset (or anything else) means
transcodes are never planned. It is not set at first deploy — set it to `1`
once a manual sweep run and posters look healthy in production. Posters are
**not** behind the switch: a video missing its thumb always gets
`makeVideoPoster`.

Caps (`src/lib/photos/repair/transcode.ts`): originals over **200 MiB** or
**120 s** are skipped permanently via `playback_skipped_reason`. Repair also
caps a streamed input and generated rendition at 200 MiB each, and each poster
at 8 MiB, so its temporary workspace stays below the function disk limit.
A larger original with no poster gets an observable `posterSkipped` and
persistent `poster_skipped_reason`; its original and video kind remain intact.
A truncated output is never published as playback. After changing the server
processing cap or supplying a valid derivative through an authorized repair,
clear the relevant skip reason to re-queue it. A video's poster and rendition share one download. Each bounded page gets
only the time left after purge and earlier work; no transcode receives a fresh
240-second allowance. A backlog drains over repeated invocations.

Re-queue one video (e.g. after raising the caps or a bad rendition):

```sql
update photos set playback_path = null, playback_skipped_reason = null
where id = '<uuid>' and deleted_at is null;
```

then run the sweep by hand. The old `_playback.mp4` object is upserted over.

**"Why does Chrome show a download card for this video?"** triage, in order:

1. `select playback_path, playback_skipped_reason, poster_skipped_reason, mime_type from photos where id = …`
2. `playback_skipped_reason` set → expected: the clip is over a cap. Re-queue
   only if you've raised the caps.
3. Both null → the sweep hasn't reached it yet (transcodes can defer). Check
   the last run's `transcodeDeferred`/`errors`, or run manually.
4. `playback_path` set but playback still fails → fetch the rendition URL
   directly; if the object is missing, re-queue (the orphan/dead-row rules
   don't cover derived objects).

### Reading the logs

Vercel dashboard → the project → **Logs**, filter on `photos.repair`. The
handler logs its aggregate JSON report: committed action `counts`, `purged`,
`purge_failed`, backlog, deferred work, exact `error_count`, and bounded
`errors` samples. Inspect that report alongside the HTTP response; there is
no guaranteed log line for each action. Some media decisions also emit
photo-specific reason logs.

The cron's own runs appear under **Settings → Cron Jobs** with their status;
the daily schedule is `0 9 * * *`.

## Triage: "a user says their upload vanished"

Work top-down; each step tells you which layer dropped it. You need the
approximate time, the job, and ideally the filename.

1. **Ask what their tray says.** A `failed` row retries in place; an
   `interrupted` row (they reloaded/killed Safari) resumes after re-picking
   the same files from the tray. "Already in this job" means the same bytes
   were already uploaded to that job — the photo is there, under the earlier
   row.

2. **Is there a row?**

   ```sql
   -- Intentional diagnostic read includes retained trash.
   select id, original_name, kind, thumb_path, created_at, captured_at_source,
          deleted_at, purge_after, duplicate_of
   from photos
   where job_id = '<job>' and created_at > now() - interval '2 days'
   order by created_at desc;
   ```

   - Row present with `deleted_at` → it is in trash. Open the trash view and
     check the recovery deadline and canonical reference before restoring.
   - Active row with `thumb_path` → it landed. "Vanished" is a viewing
     problem: check which grid/filter they're looking at (wrong job, a tag
     filter, or grouping by a sheet number they didn't expect).
   - Active row, `thumb_path` null → derivative hole (e.g. HEIC picked in
     desktop Chrome). It shows after the next sweep; run the sweep by hand
     (above) to fix it now.

3. **No row — is there an object?**

   ```sql
   select name, created_at from storage.objects
   where bucket_id = 'photos' and name like 'originals/%'
     and created_at > now() - interval '2 days'
   order by created_at desc;
   ```

   - Object without a row → the bytes arrived but finalization may still be
     unfinished. Check the upload attempt or migration item and its route
     errors; have the user resume from the tray or migration page. Unfinished
     resumable attempts protect their paths until resolved or explicitly
     cancelled, even after lease expiry. The 24-hour orphan age applies only
     to genuinely unowned or explicitly cancelled paths, and cleanup still
     requires a live check that no retained photo or other attempt owns them.
   - Nothing anywhere → the upload never reached storage: the connection died
     before the first byte, or the batch was dismissed. Re-upload.

4. **Still lost?** Run the repair sweep by hand and reread step 2 — the sweep
   converges every partial state that can be converged (`counts` tells you
   what it found).

## Rollback: the upload manager

There is no runtime switch for the browser-side upload manager — rollback is
a revert. Commit `e07574e` deleted the `NEXT_PUBLIC_PHOTOS_UPLOAD_MANAGER`
flag and the legacy in-sheet upload loop it guarded (the manager itself came
in `0f5749f`). Reverting `e07574e` restores both: the manager stays the
default, so you then have to set `NEXT_PUBLIC_PHOTOS_UPLOAD_MANAGER=0` in
Vercel and redeploy — a `NEXT_PUBLIC_` var is baked in at build time —
before the in-sheet loop actually runs.

## Launch drills (run on production after the first deploy)

Run them on an iPhone over LTE (not office Wi-Fi). Record results inline.

- [ ] **30-photo batch.** Pick 30 camera-roll photos → one job → Upload.
  Navigate between pages while the tray counts. Expect: all 30 land, the
  grid refreshes, the tray stays responsive throughout.
  Elapsed time (start → "Upload complete"): ______
- [ ] **Big-video resume.** Requires the bucket `fileSizeLimit` raised above
  the current 50 MB first (Supabase dashboard). Upload a ~500 MB video, kill
  Safari at ~50%, reopen the app → tray shows "1 upload interrupted" →
  re-pick the file → progress resumes above 0%. Expect: exactly one `photos`
  row, and no `deleteOrphanObject` for it in the next sweep.
- [ ] **Sign-out mid-batch.** Start a batch, sign out in another tab.
  Expect: remaining items fail with "Signed out — sign in and retry";
  after signing back in, Retry succeeds without re-picking.
- [ ] **Three green crons.** Three consecutive daily `/api/photos/repair`
  runs green in Vercel → Settings → Cron Jobs, each with `errors: []`.
- [ ] **Transcode turn-on** (after the above): set `PHOTOS_TRANSCODE=1`, run
  the sweep by hand, confirm the backlog clips gain `playback_path` and play
  in desktop Chrome/Firefox (see "Video transcoding" above).
