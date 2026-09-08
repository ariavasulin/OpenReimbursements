---
name: photos
description: >-
  Use when an employee wants to add or migrate job photos and videos, organize
  existing photos under another job, remove or recover photos, or resume an
  interrupted upload from local files or folders.
---

# DWS photos

Help the employee continue in the DWS photo browser, where they sign in, review
the current data, and confirm changes. Use the script descriptions and argument
schemas returned with this skill for the chosen workflow.

## Add files or migrate folders

Use `migrate_photos` for one or more local folders, including folders on an
office drive. Use `add_photos` for a smaller file selection, up to 500 files per
selection. Gather useful source labels, job numbers, sheet numbers, or tags
when the employee knows them; the browser lets the employee review and edit
those suggestions. Folder names may suggest jobs, but do not establish the
destination.

Give the employee the returned handoff URL. For folder selection, tell them to
open it in Chrome or Edge on the computer that can access the files. The hosted
service cannot read their local drive or mapped `J:` share. File bytes travel
directly from that browser to Supabase Storage, never through the conversation
or script arguments.

After DWS SMS login, the employee selects sources and reviews each source's
destination job, counts, bytes, paired XMP sidecars, exclusions, and warnings.
They confirm in the browser before uploading. Picasa internals and unsupported
files are excluded; do not promise that Picasa albums, faces, or edit recipes
will be imported. Each successful photo appears as it completes.

## Move, remove, or recover photos

Use `move_photos`, `remove_photos`, or `restore_photos` for the corresponding
change. Obtain an employee-supplied photo reference or job scope and, for a
move, the destination job. Jobs, filenames, and photo links are resolved only
after login. If a filename matches several photos, the employee selects the
intended ones in the browser; do not guess or claim that a handoff proves a
photo exists. Single-photo and bulk changes both require review and
confirmation of the exact affected photos.

Removal moves photos to recoverable trash for 30 days. Repeating removal does
not extend that deadline, and expired trash cannot be restored. Known public
file URLs remain accessible during retention. Restoration may include a
confirmed move to another job. If a legacy duplicate points to a canonical
photo, review that photo instead of promising a second active copy.

A valid handoff grants its signed-in consumer authority only for the bound
action and confirmed targets, including broader photo management than ordinary
in-app deletion. Ordinary removal and restoration require the uploader or an
administrator; SMS login alone does not grant broader removal authority.

## Continue after interruption or a conflict

Handoff links expire after 30 minutes and can be consumed once. After login and
consumption, use the authenticated batch URL shown by the browser to resume.
Request a new handoff if an unused link expires; do not try to reuse a consumed
token or erase its state. Another employee may inspect batch progress but
cannot resume using its consumer's authority.

Uploads need the browser tab to remain open. After closing it or losing drive
permission, return to the saved batch and reselect the sources; completed
photos are preserved and unfinished work can resume. Changed files need the
browser's refreshed inventory. Pause retains unfinished work. Cancel stops it
while preserving committed photos. If ordinary queue removal is still pending,
retry removal rather than claiming it has finished.

Matching bytes do not create another copy. A same-job match is skipped; a match
in another job requires a separately confirmed move, and a trash match requires
restoration. If ordinary restore is unavailable, explain: “Ask an administrator
to restore this photo, or use the MCP restore handoff.” After resolving the
conflict, return to the upload to check again and resume, or explicitly skip it.
Sidecar or preview warnings can accompany a successful original upload. Reselect
a missing XMP sidecar when offered; do not describe it as recovered from nothing.

Keep credentials, the connector URL, binary data, attachments, and
executable code out of script inputs.
