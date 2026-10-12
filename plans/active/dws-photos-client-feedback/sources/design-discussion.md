---
task: dws-photos-client-feedback
type: design-discussion
repo: ariavasulin/OpenReimbursements
branch: ariavasulin/plan-dws-photos-client-feedback
sha: 53dd82f109720a74cf40a303b3e704866dac69c7
resolved: 2026-10-12
---

# Design discussion: DWS Photos, client feedback round 1

Inputs: the client's notes in [`ticket.md`](ticket.md) and the codebase facts in
[`research.md`](research.md) (commit `53dd82f`, still the tip of `main` on 2026-10-12). Every
question below was resolved with Ari on 2026-10-12 in conversation; the resulting plan is
[`../plan.md`](../plan.md), which wins over this document where they differ.

### Summary of change request

The DWS owner sent 17 notes after reviewing the Photos app. Sorted against the app as it is today:

| # | Client note (short) | Today | Category |
|---|---|---|---|
| 1 | Delete the test library (projects, photos, trash) | Manual runbook procedure; production holds 41 photos, 4 in trash, 1 album, 0 hand-made projects, 22 office-imported projects | Launch operation |
| 2 | Admins can clean the trash | "Empty trash" exists; anyone can use it | Shipped; restricted by #3 |
| 3 | Users delete only their own photos from the last 30 days | No owner or time rule since 2026-09-20 | Feature |
| 4 | Owner, Yana, Ari start as admins | Roles are shared with the Receipts app; receipt admins ≠ photo admins | Launch operation + new flag |
| 5 | Each project has its own tag list | One global suggestion list | Small |
| 6 | Select a whole project for batch delete/edit | Projects page Select mode shipped in PR #21 (after his note); grid "select all" only covers loaded photos | Small fix |
| 7 | Connect to the office database; rename meanwhile | Rename shipped; office link is a one-time CSV script | Rename shipped; bridge out of scope |
| 8 | Every photo belongs to a project | Project is optional ("No project") | **No change** (see resolved Q4) |
| 9 | Group by Uploader and File type | Date, Tag (Project on search) | Small |
| 10 | Each group sorts up and down | Fixed newest-first | Small |
| 11 | Albums arranged by hand | Capture-date order; no position column | Feature |
| 12 | Reject duplicates across formats | Exact copies rejected; JPG+RAW twins not | Small warning |
| 13 | Auto-name `[Project#] – [YYMMDD] [HHMMSS]` | Uploaded name or hand rename | Feature |
| 14 | Edge-to-edge photos; hide chrome on tap | Toolbar/counter always shown; desktop Details panel always open | Feature |
| 15 | Slideshow | None; viewer library has a Slideshow plugin | Small |
| 16 | Mixed search criteria | One phrase, OR across project/uploader/tag; no date or type filter | Feature (filters) |
| 17 | Download or save search results to an album | Album: shipped; download: one file at a time | Zip download |

### Desired End State

- Photo admins (Yoel, Yana, Ari) can do everything; other employees can trash only photos they uploaded in the last 30 days and cannot delete forever, empty the trash, or delete a project.
- The library starts clean at launch; the 22 office projects stay.
- Tagging inside a project suggests that project's tags plus the three shared starters.
- Photos are named `3962 – 260923 160432` automatically; downloads use that name.
- Every grid has one filter bar (project, uploader, tags, file type, date range), a newest/oldest toggle, Uploader and File type grouping, and the whole state in the URL. Search words combine with AND.
- "Select all" selects every matching photo, and a selection can be downloaded as one zip.
- An album can be arranged by hand and the order is saved for everyone.
- The viewer shows photos edge to edge, hides all chrome on tap, and can play a slideshow.

### What we're not doing

- A live office-database bridge (needs discovery first).
- A required project. "No project" stays, as the owner agreed with Ari.
- Per-project tag management screens; roles beyond photo admin; a private bucket; capture-date editing.
- Export as PowerPoint (noted as a later idea).

### Resolved Design Questions

#### Q1. Blank-slate scope
Keep the 22 office-imported projects; delete all photos, trash, albums, share links, and hand-made projects. Hand-run SQL plus "Empty trash" in the app at launch, not a script — the library is tiny (41 photos). Ari: "no need for a script … just be careful."

#### Q2. Admins
A new `user_profiles.photo_admin` flag, separate from the Receipts `role` (the two apps share one backend and the receipt admins are different people). Photo admins at launch: Yoel Asulin (510-385-0837), Yana Ronin (415-734-0483), Ari Asulin (415-716-2154).

#### Q3. Employee rights
Employees: trash only own photos uploaded ≤30 days ago (by upload time). Photo admins only: delete forever, empty trash, delete a project. Anyone: restore, tag, rename, move, create/rename projects and albums, add to album. Deleting an album: admin or its creator. MCP "remove photos" follows the same trash rule. Stricter option (admin-only rename/move) rejected as blocking daily organizing.

#### Q4. Required project
**Not changing.** Ari talked to the owner: "No project" is fine as a kind of project; the column stays nullable. photo-albums Decision 1 holds.

#### Q5. Per-project tags
Suggest-only: inside project X the picker lists X's tags plus the three starters; tags stay a text list on each photo. Managed per-project lists rejected ("don't overthink it").

#### Q6. Select a whole project
"Select all" and the group-header tick select **every** matching photo, not just the loaded ones ("if you're selecting a whole project, you're clearly not just selecting the ones that are rendered"). Projects-page Select mode from PR #21 counts as shipped.

#### Q7. Sort and filters (Items 9, 10, 16)
A simple ascending/descending toggle plus real filters: project, uploader, tags (several), file type, date range, AND-combined, state in the URL; search words AND across fields. Ari: this is one workstream, keep it simple and intuitive now, richer queries later. **Must look good and work on phone and desktop; think through the UI.**

#### Q8. Album order
Drag to arrange, saved for everyone, phone included; "by date" remains as the alternative. Use case: ordering photos for a presentation or slideshow. Shuffle rejected.

#### Q9. Format twins (JPG + RAW)
Flag at upload when base name and capture second match a photo in the same project; skip by default, uploader can keep. Never silently drop — "there's a reason there's multiple versions." Kept small; edge case.

#### Q10. Naming
`<project number> – <YYMMDD> <HHMMSS>` with his en dash; ` (2)` on same-second collisions; Pacific time; photos without a project get the date-time part only; moving a photo renames it unless hand-renamed; original filename stays under "About this file"; share-link downloads use the new name too.

#### Q11. Viewer
Edge to edge is the main thing. Tap hides all chrome; desktop Details behind an "i" button, hidden by default; as native-feeling as iPhone Safari and Windows Chrome allow (no true fullscreen on iPhone).

#### Q12. Slideshow
Play button on project, album, and search pages and in the viewer; 4 s, loops, photos only. Keep the UI small. "Download as PowerPoint" noted for later.

#### Q13. Download
Zip built in the browser from the originals, new file names, warning above ~2 GB, desktop first.

#### Q14. Delivery
Two waves, one PR per unit: rules, admins, naming, tags, grouping/sort first (what must hold before real photos arrive), then filters, select-all/download, album order, viewer/slideshow, format twins.

### Patterns to follow

From the research: SQL permission checks in the action functions, `ownership` route driving the UI, `GroupBy` switch in `group.ts`, fixed order in `GET /api/photos` with `keysetCursor.ts`, YARL plugin list, and the rendered look-and-feel review from photo-albums Decision 14.
