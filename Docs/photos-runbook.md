# Photos Runbook

Operational notes for the DWS Photos hub (uploads, repair sweep). Grows a
section per phase of the upload-pipeline-hardening work.

## Repair sweep (`/api/photos/repair`)

A daily Vercel cron (09:00 UTC, `vercel.json`) that converges every partial
upload state. It is idempotent — running it twice in a row is harmless, and
the second run should report `planned: 0` when nothing new broke.

### Run it by hand

```sh
curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
  https://photos.dws-receipts.com/api/photos/repair
```

`CRON_SECRET` is the Vercel environment variable of the same name. The
response looks like:

```json
{ "counts": { "fillImageDerivatives": 2 }, "errors": [], "planned": 2 }
```

### What each `counts` key means

| Key | What happened |
| --- | --- |
| `fillImageDerivatives` | An image row had no thumbnail (client couldn't decode it — e.g. HEIC picked in Chrome). The sweep rendered a thumb + preview via Supabase image transforms and filled the row. |
| `markFileTile` | An image couldn't be transformed (RAW format, or original over 25 MB, or the transform endpoint refused it). The row was set to `kind='file'` — a deliberate file tile, not a hole. Check the log line for the reason. |
| `makeVideoPoster` | A video row had no poster. The sweep downloaded the original, extracted a frame with ffmpeg (~1 s in), uploaded it as thumb + preview WebPs, and recorded `duration_secs`. |
| `transcodeVideo` | A video within the caps gained an H.264/AAC `playback_path` rendition (`derived/{uid}/{photoId}_playback.mp4`). Only planned when `PHOTOS_TRANSCODE=1`. |
| `playbackSkipped` | A planned transcode found the clip over a cap (200 MB or 300 s) and set `playback_skipped_reason` instead. The sweep never replans it; the lightbox shows the download card. |
| `transcodeDeferred` | The run's 240 s transcode budget ran out before this clip started. Nothing was written; the next run (or a manual one) picks it up. |
| `deleteOrphanObject` | An object under `originals/` had no `photos` row pointing at it (original **or** sidecar) and was older than 24 h — a dead upload whose finalize never ran. Deleted. |
| `deleteDeadRow` | A `photos` row's original object is missing from storage — finalize raced a dead upload. Row deleted. |

`errors` lists actions that failed (`"<action>: <message>"`); each action is
isolated, so one failure never aborts the rest of the sweep. Rows younger
than 10 minutes are always skipped — the client may still be uploading its
derivatives.

### `?olderThan=<ms>` (drills only)

The 24 h orphan age protects in-flight resumable uploads. For a drill
(verify a killed upload's object gets swept) override it on a manual run:

```sh
curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
  "https://photos.dws-receipts.com/api/photos/repair?olderThan=0"
```

Do not use `olderThan=0` while anyone might be mid-upload: a TUS upload's
object can look row-less until its finalize lands.

### Video transcoding (`PHOTOS_TRANSCODE`)

The H.264 playback rendition is behind the `PHOTOS_TRANSCODE` Vercel env
var — set it to `1` to turn transcoding on; unset (or anything else) means
transcodes are never planned. Posters are **not** behind the switch: a video
missing its thumb always gets `makeVideoPoster`.

Caps (`src/lib/photos/repair/transcode.ts`): originals over **200 MB** or
**300 s** are skipped permanently via `playback_skipped_reason`. Transcodes
always run after every other action and stop starting after 240 s of wall
time (`transcodeDeferred`), so a big backlog drains across daily runs.

Re-queue one video (e.g. after raising the caps or a bad rendition):

```sql
update photos set playback_path = null, playback_skipped_reason = null where id = '<uuid>';
```

then run the sweep by hand. The old `_playback.mp4` object is upserted over.

**"Why does Chrome show a download card for this video?"** triage, in order:

1. `select playback_path, playback_skipped_reason, mime_type from photos where id = …`
2. `playback_skipped_reason` set → expected: the clip is over a cap. Re-queue
   only if you've raised the caps.
3. Both null → the sweep hasn't reached it yet (transcodes can defer). Check
   the last run's `transcodeDeferred`/`errors`, or run manually.
4. `playback_path` set but playback still fails → fetch the rendition URL
   directly; if the object is missing, re-queue (the orphan/dead-row rules
   don't cover derived objects).

### Reading the logs

Vercel dashboard → the project → **Logs**, filter on `photos.repair`. One
line per action:

```
photos.repair action=fillImageDerivatives photoId=<uuid> ok
photos.repair action=markFileTile photoId=<uuid> reason=render 400
photos.repair action=deleteOrphanObject path=originals/<uid>/<photoId>/x.jpg err=<message>
```

The cron's own runs appear under **Settings → Cron Jobs** with their status;
the daily schedule is `0 9 * * *`.

## Triage: "a user says their upload vanished"

Work top-down; each step tells you which layer dropped it. You need the
approximate time, the job, and ideally the filename.

1. **Ask what their tray says.** A `failed` row retries in place; an
   `interrupted` row (they reloaded/killed Safari) resumes after re-picking
   the same files from the tray. "Already in this job" means the same bytes
   were already uploaded to that job — the photo is there, under the earlier
   row. The browser logs `photos.upload photoId=<uuid> status=…` to the
   client console only — you will usually not have it after the fact, so go
   server-side:

2. **Is there a row?**

   ```sql
   select id, original_name, kind, thumb_path, created_at, captured_at_source
   from photos
   where job_id = '<job>' and created_at > now() - interval '2 days'
   order by created_at desc;
   ```

   - Row present with `thumb_path` → it landed. "Vanished" is a viewing
     problem: check which grid/filter they're looking at (wrong job, a tag
     filter, or grouping by a sheet number they didn't expect).
   - Row present, `thumb_path` null → derivative hole (e.g. HEIC picked in
     desktop Chrome). It shows after the next sweep; run the sweep by hand
     (above) to fix it now.

3. **No row — is there an object?**

   ```sql
   select name, created_at from storage.objects
   where bucket_id = 'photos' and name like 'originals/%'
     and created_at > now() - interval '2 days'
   order by created_at desc;
   ```

   - Object without a row → the bytes arrived but finalize (`POST
     /api/photos`) never did. Check the Vercel logs for `/api/photos` 4xx/5xx
     around that time for the why. There is no server-side recovery (the row
     needs client-known metadata); have the user retry from their tray, or
     re-upload. The orphan object is swept after 24 h.
   - Nothing anywhere → the upload never reached storage: the connection died
     before the first byte, or the batch was dismissed. Re-upload.

4. **Still lost?** Run the repair sweep by hand and reread step 2 — the sweep
   converges every partial state that can be converged (`counts` tells you
   what it found).

## Kill switches

- **`PHOTOS_TRANSCODE`** (Vercel env var) is the one deliberate switch left:
  it gates only H.264 transcodes in the repair sweep (see above). It is NOT
  set at first deploy — set it to `1` once a manual sweep run and posters
  look healthy in production.
- **`NEXT_PUBLIC_PHOTOS_UPLOAD_MANAGER`** and the sheet's legacy in-place
  upload loop were removed in Phase 8 (the legacy path was never
  production-verified either, so it was no safer than the manager, and
  flipping a `NEXT_PUBLIC_` var needs a redeploy anyway). If the manager
  misbehaves in production, roll back by reverting the Phase 8 commit —
  that restores the legacy loop behind `NEXT_PUBLIC_PHOTOS_UPLOAD_MANAGER=0`
  — then set that var and redeploy.

## Launch drills (run on production after the first deploy)

Nothing below has been run yet — these are the Phase 8 acceptance drills,
written down for whoever deploys. Run them on an iPhone over LTE (not
office Wi-Fi). Record results inline.

- [ ] **30-photo batch.** Pick 30 camera-roll photos → one job → Upload.
  Navigate between pages while the tray counts. Expect: all 30 land, the
  grid refreshes, the tray stays responsive throughout.
  Elapsed time (start → "Upload complete"): ______
- [ ] **Big-video resume.** Requires the bucket `fileSizeLimit` raised above
  the current 50 MB first (Supabase dashboard — flagged in the plan's Open
  Questions). Upload a ~500 MB video, kill Safari at ~50%, reopen the app →
  tray shows "1 upload interrupted" → re-pick the file → progress resumes
  above 0%. Expect: exactly one `photos` row, and no `deleteOrphanObject`
  for it in the next sweep.
- [ ] **Sign-out mid-batch.** Start a batch, sign out in another tab.
  Expect: remaining items fail with "Signed out — sign in and retry";
  after signing back in, Retry succeeds without re-picking.
- [ ] **Three green crons.** Three consecutive daily `/api/photos/repair`
  runs green in Vercel → Settings → Cron Jobs, each with `errors: []`.
- [ ] **Transcode turn-on** (after the above): set `PHOTOS_TRANSCODE=1`, run
  the sweep by hand, confirm the backlog clips gain `playback_path` and play
  in desktop Chrome/Firefox (see "Video transcoding" above).

## Related

- Uploads log `photos.upload photoId=<uuid> status=done|failed|duplicate`
  from the browser-side manager (visible in the client console, not Vercel).
- `DELETE /api/photos/:id` removes the row's storage objects (original,
  thumb, preview, sidecar) in the same request; anything it misses is
  exactly what the orphan sweep collects on the next run.
