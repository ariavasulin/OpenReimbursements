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
selection. Gather useful source labels, job numbers, album names, or tags
when the employee knows them; the browser lets the employee review and edit
those suggestions. Folder names may suggest projects, but do not establish the
destination.

The application organizes photos with three words. An **album** is like a
folder, and a photo can be in more than one. A **project** is the job a photo
belongs to, and it is optional. A **tag** is a label to filter by, such as
`professional` or `shop drawing`.

Folders become albums. Every imported folder that directly holds photos becomes
one album with the same name, taken from its path under the picked folder, so
`Smith Residence/Finished` arrives as the album `Smith Residence – Finished`.
The employee can find every folder again by name under Albums. Tell them this
plainly when they ask where their folders will go. An `album_name` suggestion
on a source names the album for photos sitting directly inside that picked
folder; folders inside it keep the names of their paths.

A project is optional. Photos that belong to no office job, such as a holiday
party or a marketing collection, need no project at all: do not invent one for
them. Suggest a `job_number` only when the photos belong to that job. When they
belong to a project that has no job yet, suggest a short `new_project_name`
instead. This creates nothing: the employee reviews the name in the browser,
sees any existing project that matches, and creates it there. A project made
without an office job number receives a generated `P-` code; use that code as
its job number afterwards. The browser may also suggest a project when a folder
name contains an existing project number; the employee sees and can change it.

Tags can be set per folder. A `tags` suggestion on a source applies to every
folder inside it, and in the browser the employee can set a project and tags on
any one folder, or on a top-level folder to cover everything inside it. Finer
tagging happens after the import.

Loose files added with `add_photos` need a project or an album, new or existing.
Suggest an `album_name` when the employee describes a collection rather than a
job.

Give the employee the returned handoff URL. For folder selection, tell them to
open it in Chrome or Edge on the computer that can access the files. The hosted
service cannot read their local drive or mapped `J:` share. File bytes travel
directly from that browser to Supabase Storage, never through the conversation
or script arguments.

After DWS SMS login, the employee chooses a folder and reviews one row per
folder: its album name, photo count, project, and tags. Counts, bytes, paired
XMP sidecars, exclusions, and warnings are available under "More detail".
Pressing Start with no edits is always valid. Nothing is created before they
confirm in the browser, and an album appears only once a photo has landed in
it. Picasa internals and unsupported files are excluded; do not promise that
Picasa or Mylio albums, faces, ratings, keywords, or edit recipes will be
imported: albums here come from folders. Each successful photo appears as it
completes.

## Move, remove, or recover photos

Use `move_photos`, `remove_photos`, or `restore_photos` for the corresponding
change. Obtain an employee-supplied photo reference or job scope and, for a
move, the destination job. Jobs, filenames, and photo links are resolved only
after login. A move needs a destination job that already exists. If the project
does not exist yet, the employee creates it first, in the photos application or
through an `add_photos` handoff, and the move then uses its job number. If a filename matches several photos, the employee selects the
intended ones in the browser; do not guess or claim that a handoff proves a
photo exists. Single-photo and bulk changes both require review and
confirmation of the exact affected photos.

Removal moves photos to recoverable trash for 30 days. Repeating removal does
not extend that deadline, and expired trash cannot be restored. Known public
file URLs remain accessible during retention. Restoration may include a
confirmed move to another job. If a legacy duplicate points to a canonical
photo, review that photo instead of promising a second active copy.

Any signed-in employee can move, trash, and restore any photo. A handoff remains
bound to its signed-in consumer, action, and confirmed targets; another employee
cannot run that batch. Both handoffs and in-app actions require confirmation.

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

Matching bytes do not create another copy. The photo that already exists is
added to the folder's album instead, which is how a folder full of copies, such
as a marketing collection, becomes an album of the same photos. If it has no
project yet it takes the folder's; if it already has the same one, nothing
changes. A match that already belongs to a different project keeps that project
and is reported as a conflict: changing it requires a separately confirmed
move. A match sitting in trash is left alone and requires restoration. Any signed-in employee can restore it from Trash within 30 days. Expired trash
cannot be restored. After resolving the
conflict, return to the upload to check again and resume, or explicitly skip it.
Sidecar or preview warnings can accompany a successful original upload. Reselect
a missing XMP sidecar when offered; do not describe it as recovered from nothing.

Keep credentials, the connector URL, binary data, attachments, and
executable code out of script inputs.
