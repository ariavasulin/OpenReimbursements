# Plan revision journal

## 2026-09-04 — Incorporate Claude review

The user requested a Claude review, then authorized incorporating the findings. The [review](reviews/2026-09-04-claude.md) returned **NEEDS CHANGES** for the preceding plan and judged a single implementation PR feasible. This revision keeps seven sequential phases and fourteen acceptance criteria. Implementation has not started; the revised plan has not received another review.

Review provenance: independent, read-only Claude delegation; high tier; attested model ID `fable`; transport `claude-read-only-v22`; session `593fd875-5a11-4a18-8517-1a58e5f6be13`. The worker completed and joined before these edits. It reviewed repository commit `142b09c80977c25206ff6883294aa54326efb0d5` and plan SHA-256 `45f9208b9e42385ecc62522802834d841b7651c319a469fc92358e220346fe70`.

| Finding | Disposition in the revised plan |
|---|---|
| B1 — Rollback could expose trash | Accepted. Phase 1 installs active-only photo SELECT RLS; verified service-role routes own intentional trash/dedupe/ownership reads. AC-14 and Phases 1/7 replay old queries, RPCs, and Delete under retained new policies/grants. Old writes and service-role repair still require closed gates and a forward fix. |
| B2 — No reachable isolated vendor endpoint | Accepted using the activation alternative. An SDK HTTP client exercises the local route and isolated backend before merge. Actual ChatGPT/Claude checks use the existing production HTTPS endpoint during operator-only activation, with a fresh withheld secret, bounded handoff consume/cancel, and no automatic issue publication. Both must pass before employee distribution. |
| B3 — Browser test executor missing | Accepted. Phase 3 introduces Playwright Test/Chromium and `test:browser`, deterministic directory handles injected from the runner, real isolated routes/Storage/worker hashing, close/reopen and lease-contention scenarios, and saved evidence. Native picker/drive behavior remains an explicit office drill; screenshots require a recorded manual visual ruling. |
| N1 — Transport mode unspecified | Accepted. Require stateless per-request Web-standard transport, validate the selected SDK at Phase 6 entry, and recreate handlers between SDK-client requests. |
| N2 — Duplicate-object cleanup authority | Accepted with transaction-boundary clarification. The finalize route performs service-role Storage cleanup after database commit; cleanup failure preserves the canonical outcome. Remove browser Storage DELETE and test shared/canonical-path protection. |
| N3 — Someone else's trash has no ordinary remedy | Accepted. Show the administrator/MCP restore remedy, preserve unresolved-or-skipped state, prohibit a second copy, and test both ordinary denial and authorized resolution. |
| N4 — Old cron suspension unspecified | Accepted. Disable Vercel Cron Jobs, stop manual invocation, drain the last old run, and verify the compatible closed-gate handler before creating trash. Open the new repair gate for a manual run while scheduling stays disabled; resume scheduling only on success. |
| N5 — Consolidate the phone queue | Considered; retain the tested phone/camera manager and record the warrant. It shares hashing, claims, and finalize with migration but uses a smaller attempt ledger. Consolidation becomes appropriate if observed duplicate orchestration causes drift. |
| N6 — Command, critical path, portability, alternatives | Accepted. Correct the TypeScript command and working directory; identify phase dependencies, scaffolding, and highest-scrutiny contracts; freeze local authoring/implementation references; document why signed upload tokens and S3 multipart are not selected. |
| Evidence gap — Concurrent-index bootstrap | Addressed. Phase 1 boots an isolated empty-migration stack and replays repository migrations with the README's transactional versus concurrent-statement conventions, explicit target checks, and invalid-index validation. |

The frozen ticket, research, and System Design remain historical inputs. Where the review strengthens their mechanisms, the native [plan](plan.md) is authoritative. The copied planning-contract files preserve the requested authoring context; demo-only paths and tools are not added as execution prerequisites.

Production data counts, canonical choices, account eligibility, office-drive behavior, and activation evidence remain explicitly pending implementation/operator work. This revision supplies their executors and sequencing; it does not claim those checks have run.

## 2026-09-07 — Local implementation retrospective

The seven-phase dependency chain held through implementation and isolated verification. The recurring correctness concern was current ownership at transaction boundaries: canonical finalization, confirmed actions, restoration and repair needed database checks after locking, plus permanent path/UUID fences once deletion was authorized. The local PostgreSQL/Auth/Storage harness and actual HTTP/browser scenarios supplied evidence that mocks alone could not establish.

Full-change local correctness reviews found no actionable defects. The content and structural audit consolidated existing helpers, removed unused state, separated scanning and TUS transport from their callers, reduced repeated reads, and clarified operator sequencing. GitHub's Retry-After parser remains separate because its fallback and timestamp rules differ from upload retries. A final database test exposed a host-versus-Docker clock comparison; using exact database-time bounds preserved the renewal guarantee without a timing tolerance.

The imported demo planning references remained useful discipline, while this repository's executable harness supplied the actual gates. No product decision changed. The native office drill and production activation observations remain required; complete the activation retrospective and plan lifecycle transition after those outcomes are recorded.
