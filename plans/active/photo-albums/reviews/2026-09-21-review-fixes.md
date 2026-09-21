<!-- staleness-exempt: dated review disposition and verification evidence -->
# Claude and Gemini review fixes — 2026-09-21

The user authorized applying fixes at the implementer's discretion, then stopping.
Verification completed locally on `ariavasulin/photo-albums`, based on `bbe03fb9`.
The user subsequently authorized committing and pushing the verified fixes to
PR #20. Merge, deployment, and production changes remain outside that authorization.

## Changes

- Album and project summary APIs now return bounded pages with explicit cursors.
  The shared clients follow every page, preserving timestamp precision and sort
  ties. Scalar JSON responses avoid PostgREST's 1,000-row table response cap.
  Album cards and navigation entries also render bounded pages.
- An approved import cannot silently acquire unreviewed folders on rescan. Seal
  rejects the entire new inventory with a clear 409 response; the user starts a
  new import for those folders. Existing-folder rescans still work, including
  newly discovered unsupported files. Previously imported photos remain intact.
- Inactive projects no longer serve public share pages. Revocation while inactive
  remains possible, and reactivation does not revive a revoked token.
- Folder review bounds flat trees, expanded groups, and broad searches. Start
  receives the click after a blur save, waits for queued edits, and blocks on a
  failed edit until it is corrected. The engine receives the persisted choices.
- The import album chooser requires an explicit existing-album or Create choice,
  supports arrow keys and Enter, and cancels stale searches. Blurring an unfinished
  search cannot create a duplicate. The first Escape closes tag/album suggestions;
  a second Escape can close the containing pop-up.
- MCP photo references accept album and search viewer URLs while retaining origin,
  UUID, and malformed-path checks.
- Rollout documentation puts production checks before the Sheet # drop, names the
  hosted-photo prerequisites, and limits code rollback to compatible data with no
  migration batches. Sharing still requires independent security evidence. The
  planner regression is described as a reproduced statistics condition, without
  claiming ordinary production growth caused it.

## Disposition limits

The existing-photo rule still preserves existing tags; adding folder tags to a
duplicate would change that deliberate behavior. Draft rescans still show new
folders with source defaults rather than inheriting edited ancestor choices.
The share switch's button is labelable; the contrary review claim did not justify
a change. The auth-cookie rename was already in `origin/main`.

This pass does not redesign phone selection, filter restoration, all photo-grid
rendering, or the MCP move schema. It does not certify physical-device reflow or
the office drive's actual shape and keyword data. Those operator/data checks and
the independent sharing review remain separate from these local fixes. The local
Codex review timed out; no completed Codex review is claimed.

## Verification

Logs are under `.artifacts/photo-albums/verification/review-fixes/`. Database,
route, and browser runs use disposable local Supabase stacks; the app runs from
a source-only snapshot that excludes production environment files.

- Unit: **642/642** in 52 files (`unit.log`).
- Database: **137/137** in 13 files (`db.log`), including migration replay twice,
  collections above 1,000 rows, atomic rescan refusal, and inactive shares.
- Routes: initial **120/122**, followed by **26/26** in the two affected files
  (`routes.log`, `routes-followup.log`). Both initial failures were test issues:
  the old album-URL rejection expectation and a new fixture missing `captured_at`.
  Every route case has passed after those corrections.
- The 100,000-entry planner regression sealed in **2,385ms**, below **8,000ms**.
  The 5,000-folder database case sealed in **383ms**, rescanned in **398ms**, and
  applied a picked-folder choice in **98ms**. These are local measurements.
- TypeScript: clean after final test corrections (`tsc-final.log`).
- Browser: initial **42/44**, followed by **2/2** for the corrected assertions
  (`browser.log`, `browser-followup.log`). One selector also matched Next.js's
  hidden route announcer; the other incorrectly expected a new-album name on an
  existing-album row, which correctly stores only its ID. Every browser case has
  passed after those test corrections. The follow-up verifies failed-save retry,
  explicit keyboard selection, prevention of blur-created duplicates, and Escape.
- The 5,000-folder browser benchmark opened the last group in **121ms** and tagged
  all folders in **189ms**. Flat trees and broad searches retain 100 controls per
  page and can reach/edit the last folder.
- Final `git diff --check` is clean. All disposable test stacks were removed.
