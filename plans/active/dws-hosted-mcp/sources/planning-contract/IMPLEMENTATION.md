# Working a Plan

This file covers implementation against an authored plan. [`AGENTS.md`](AGENTS.md) defines the always-on contract; [`refs/authoring.md`](refs/authoring.md) defines authoring conventions.

The plan fixes the contract (*what*), rarely the full mechanism (*how*).

## Phase Entry

1. Re-read the plan top-to-bottom; the plan is the contract, not your recollection.
2. Identify the current phase, its already-satisfied acceptance criteria, entry or rollout gates, deferred work, and unresolved deviations. If phases have declared dependency edges, verify every predecessor edge rather than assuming document order.
3. Open every exact source named by the plan, PRD, review, or user that bears on the current phase, and trace the load-bearing dependency path of those the phase changes. Search and summaries are not substitutes.
4. Run every derived inventory recipe the phase declares, check its completeness invariant, and replace the plan's working inventory with the result; do not execute from the authored snapshot. A fixed inventory needs no recipe.
5. Run any premise-anchor revalidation probes the plan declares, then resolve missing prerequisites, stale premises, deferred decisions now due — through their ruling owner, recording the ruling — and genuine human-owned decisions that could change the phase's contract, authority, safety posture, or deliverable shape.

## Phase Execution

- Stay inside the current phase. Work belonging to a later phase waits unless the plan or user explicitly combines the phases; a convenient dependency or nearby file does not expand the execution scope.
- Run verification items when their behavior becomes observable, and complete all applicable items before the phase exits. Preserve evidence in the plan, PR, or test output only when a later reader or gate consumes it; do not create a parallel execution ledger.
- Keep plan status, acceptance criteria, and contract prose current when implementation changes their meaning. Ordinary private mechanism choices stay in code.

A phase may span several sessions without re-planning while its decisions and integration boundary stay coherent: re-run Phase Entry in each new context so derivation yields the residual worklist, and run `/peprkit:handoff` before leaving a phase incomplete or moving execution to another session.

The main thread owns plan interpretation, contract changes, and phase acceptance, and is the plan file's only writer.

Delegate bounded independent implementation or verification units per [`../refs/delegation-workloads.md`](../refs/delegation-workloads.md), briefing by pointer — plan, phase, assigned unit, and applicable ACs — so the worker reads the plan and derives its worklist from the checkout. Workers report contract-level deviations and judgment calls the plan does not cover; implementation-level deviations stay theirs. Brief a delegated verifier with the AC and its named scenario, then re-check the returned diff or command output on the main thread before ticking its box.

## Divergence And Re-Plan

When reality and plan disagree, classify before acting — a preference for an alternative the plan already rejected is not new evidence:

- **Implementation-level deviation**: helper name, private layout, or library swap that does not affect the contract. Code it; no plan update.
- **In-phase contract correction**: an AC clarification, approach correction, new constraint, or added/removed AC that stays within the authorized phase and introduces no human-owned choice. Update the plan in the same PR and continue.
- **Stale AC prose**: code touched a file or surface named in an AC/example/Verify item — re-read those items against the new state; where the prose no longer matches, update it in the same PR.
- **Material surprise**: the premise is wrong, acceptance criteria conflict, the phase's seam does not exist as planned, the approach hits an obstacle that cannot be designed around, the phase boundaries no longer match reality (a phase depends on work a later phase owns), or proceeding would change authorized scope, safety posture, or expected output. Stop and return to the user or owning decision-maker before more code lands.
- **Re-plan upward**: friction traces to a PRD or master-plan decision. Surface the parent decision rather than engineering around it locally or expanding implementation authority.
- **Recurring-axis re-plan**: the same architectural concern recurs across review rounds at different file:lines or framings. Stop and re-plan; do not keep applying local symptomatic fixes. A decline that defers to an unlanded artifact must verify it retires the class; price patches against the axis's cumulative cost, not this round's diff. When the axis generalizes past this plan, promote it to its owning `refs/` or `AGENTS.md`; automate only after it recurs across plans.
- **Trigger-anchored re-plan**: the divergence tells you which decisions to revisit, not the ceiling. Rank affected decisions by blast-radius first.

One test decides contract-level: would a fresh implementer be misled tomorrow if the plan stayed as written? Push through ordinary build friction and resolve implementation-owned discoveries without a pause. Ambiguity that would materially change the contract is not ordinary friction.

## Failure Modes

- **Implementation drift.** Plan says one thing, code another. Fix: classify divergence and update the plan when contract-level.
- **Approval ceremony inside a phase.** Unblocked work waits for a recap, elapsed-time checkpoint, or fresh sign-off that no entry or exit criterion requires. Fix: continue to the phase exit.
- **Verify-as-formality.** Boxes ticked without running scenarios. Fix: observe the acceptance behavior before claiming completion.
- **Implementation-plan headstone.** A completed implementation plan remains active. Fix: complete its lifecycle transition in the merging PR; do not retire a governing index that still routes live work.
- **Stale active plan.** Status says active but work paused or moved on. Fix: defer/abandon, or substantively update before resuming.
- **Retro-skipped completion.** Final phase lands without the completion retro. Fix: run the retro before archive/delete.
- **Trigger-anchored re-plan.** Immediate failing surface drives the whole revision. Fix: revisit highest-blast-radius affected decisions first.

## Phase Exit

Before marking the current phase done:

1. Every applicable phase AC and Verify item has observed evidence at its named scenario or entry point.
2. Suites for the changed dependency paths are green, or an unresolved failure is explicitly dispositioned and prevents a false completion claim.
3. Phase checkboxes, plan status, deferred work, and contract prose match the implementation that landed.
4. The phase exit criteria and plan success criteria still match the behavior learned during implementation.
5. If this is the final phase of an implementation plan, disposition every remaining recorded deferral — route durable repository work to a directly opened tracked issue (`/peprkit:todo-issues` scans branch-diff TODO comments, not markdown) or drop it with rationale in the merging PR.
6. At that same final phase, run the completion retro below and complete the plan's lifecycle transition in [`refs/authoring.md`](refs/authoring.md) § Lifecycle. Before that transition, run `scripts/check-plan-staleness.py --strict <plan file>` (from repo root): final phase is when the build has moved files most, so this catches plan-cited paths that went stale during implementation, and `--strict` fails rather than warns. If the artifact is a governing index, reconcile its routed children and current sequencing instead of marking it done while that job remains live.

## Completion Retro

Run once per plan, at final-phase completion and before archive or delete: did the contract and phasing hold, did the same axis recur across divergences or review rounds, and did the harness over- or under-specify anything? Propagate only what recurs or generalizes; a one-off stays in the archived plan.
