<!-- staleness-exempt: dated integration and security evidence -->
# Integration and security verification — 2026-09-21

The combined branch implements Phases 1–7. UI work is committed as `a830dda`; the folder-import/share branch was integrated as `e2e1019`. Repair commit `01d10e5` changes presentation only. Production migration, deploy, and sharing activation remain operator work.

## Verification

| Check | Observed result | Local log |
| --- | --- | --- |
| Unit | 632/632 in 49 files after repair | `.artifacts/photo-albums/verification/repair-unit.log` |
| TypeScript | No errors after repair | `repair-tsc.log` |
| Build | 57/57 pages, placeholder environment | `repair-build.log` |
| Database | 134/134 in 13 files on the integrated implementation | `merged-db.log` |
| Routes | 116/116 in 11 files on the integrated implementation | `merged-routes.log` |
| Browser | 39/39 after repair (7.0 minutes) | `repair-browser.log` |
| Live browser repair | Both layouts, completed flows and fixes, no uncaught page errors | [Repair report](2026-09-21-repair.md) |

Database and route logs are under the same verification directory. All database runs used disposable local Supabase stacks. Migration replay ran twice, with legacy compatibility/grants and closed default gates checked. No production schema or deploy was changed.

The import cliff regression sealed **100,000 entries** with **1,500 live photos** in **3,387ms**, under its **8,000ms** limit, while the planner still estimated one row. The 5,000-folder database case took **447ms** to seal, **541ms** to rescan, and **112ms** for a picked-folder choice. The merged browser run opened the last 5,000-row group in **147ms** and tagged every folder in **430ms**. These are local regression measurements, not production throughput promises.

The earlier merged browser run passed 38/39; its only failure was an old project-import selector. `projects.spec.ts` was updated to the new Choose folder/Make a new project/visible project-choice labels, then both project tests passed. The final full browser run passed all 39 scenarios together; its 5,000-row timings were 150ms to open the last group and 470ms to tag all folders. G1–G6 now uses real selection, Add to album, Tag, filtering, and Share controls between the import and signed-out visit.

## Security review record

The handoff explicitly recorded completed mechanical comparisons of every re-created SQL function in `20260921024651_photo_albums.sql`, `20260921035400_photo_import_albums.sql`, and `20260921040000_photo_share_links.sql`: only the named changes, no added role checks, and grants restated by name. It also recorded a security read of `photo_share_read`, `/api/share/[token]`, and their adversarial tests. That evidence is carried forward as instructed; it was not rerun or relabeled as a new independent review. The merge and repair did not change these migrations or the public read implementation.

Current integrated database/route suites passed the public-boundary cases:

- The token chooses the album/project; request parameters cannot widen it. Album A excludes B-only/no-album photos; a project excludes other projects; trashed photos and files are absent.
- Output omits uploader names, tags, XMP paths, other album membership, and project numbers. Browser roles cannot read the token table or invoke share functions directly.
- Unknown, malformed, revoked, deleted-target, invalid-cursor, and gate-closed reads reveal no target and return the uniform unavailable result. Revoking and re-enabling creates a new token; the old token remains unavailable.
- Link mutation requires a signed-in employee, same-origin request, and exactly one live target. Concurrent enable operations produce one active link.
- The page and API send `Cache-Control: no-store` and `X-Robots-Tag: noindex`. Closing `sharing_enabled` leaves the signed-in photo API working.

The live repair pass additionally exercised album and project on/off from both layouts. Separate signed-out contexts opened and downloaded, then got a real page 404 immediately after off. The default production gate remains closed until the operator completes the rollout checks and records the security evidence in the PR.

**Accepted privacy limit (Decision 12):** the storage bucket stays public. Turning off a share page cannot revoke saved/copied image addresses or downloaded files. The Share popup and runbook state this; private storage with signed URLs is outside this change.

## Integration judgments and remaining data

- All five bulk actions accept **500 selected photos**. Set project/Trash materialize explicit IDs in bounded pages of 100, stop at unresolved references, and still require confirmation. The JSON request cap is 64KiB so 500 UUIDs fit. Route tests apply all 500, refuse 501, leave the extra photo untouched, and require explicit resolution/skip for a missing ID.
- Folder albums are created once, under a row lock, when the first new or active duplicate photo lands. All-failed/all-skipped folders leave no album. A root row uses the picked folder's label; subfolders use their relative path with ` – ` separators, without an extra root prefix.
- Joining an existing photo to an imported album preserves its tags. Folder tags apply to new photos; retagging existing photos is an explicit bulk action. This follows the same-photo rule's limited changes.
- Project-name inference needs an unambiguous whole-word existing number of at least three characters. An MCP/source hint wins. A newly discovered rescan row uses visible source defaults and name suggestions, without inheriting an already edited ancestor row. Existing rows retain their reviewed choices; applying a parent choice updates the current subtree.
- Duplicate bytes within one import can wait for the existing two-minute content claim. Tests advance only the retry timestamp to exercise resume; they do not shorten the claim. No new duplicate identity path was introduced.
- The importer now uses the shared TagDropdown. The album and project headers both use ShareButton. The stale uploader/admin restriction was removed from MCP photo guidance. The importer pagination and lost-Start-click fixes are retained.
- The earlier import worktree was fast-forwarded onto the Phase 3 base before its feature commits. Actual integration conflicts were the project page and upload client; the runbook and MCP browser test merged automatically and were inspected.
- The office's Mylio keyword contents and actual folder-tree shape remain the plan's two open `needs-data` questions. Physical-device and production checks remain outside the local evidence.
