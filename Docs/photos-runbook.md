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
| `makeVideoPoster` | A video row has no poster. **No-op until the ffmpeg work lands (Phase 6)** — the count just shows the backlog. |
| `transcodeVideo` | A video needs an H.264 rendition. Only planned when `PHOTOS_TRANSCODE=1`; no-op until Phase 6. |
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

## Related

- Uploads log `photos.upload photoId=<uuid> status=done|failed|duplicate`
  from the browser-side manager (visible in the client console, not Vercel).
- `DELETE /api/photos/:id` removes the row's storage objects (original,
  thumb, preview, sidecar) in the same request; anything it misses is
  exactly what the orphan sweep collects on the next run.
