# Plans

Detailed on-demand reference for plan authoring. The injected routing and always-on guards live in [`../AGENTS.md`](../AGENTS.md); implementation discipline lives in [`../IMPLEMENTATION.md`](../IMPLEMENTATION.md). Read this file before drafting or materially revising a plan.

## Plan Conventions

### Purpose And Shape

Plans are mechanism-precise build commitments: contract, build sequence, and per-phase proof. They are not roadmaps, runbooks, PRDs, or post-hoc narratives.

Every plan declares its shape mix in the first paragraph:

- **Design doc / RFC** — should we do this and roughly how.
- **Tech spec** — what exactly is the contract.
- **Implementation plan** — who builds what in what order, and how each step is proven.

PRD-coupled plans carry tech-spec + impl-plan; the PRD did the design-doc work. Standalone infra, refactor, and platform plans usually carry all three. If a tech spec accumulates "we'll figure it out during implementation," relabel it as design-doc work; if an implementation plan grows alternatives, it is regressing to design.

Split a plan when groups of ACs have independent premises or landing paths; several contracts alone do not require a split. If missing evidence defines a genuine horizon, end the plan there and author the later work after the evidence exists.

The harness is proportional. If a plan has no new contract surface, no cross-artifact dependency, and no meaningful implementation ambiguity, declare it *lightweight* in the preamble and keep only the sections that remain reviewable.

### Consequence And Delivery

Every plan declares two independent ordered postures in its first paragraph, beside the shape mix.

**Consequence** is the cost of a wrong decision at the contract surface:

- **contained** — a miss stays inside one team or disposable artifact and is cheap to detect and undo.
- **consequential** — a miss crosses an ownership boundary, corrupts durable state, creates material operating cost, or requires coordinated recovery.
- **critical** — a miss can spend money, expose protected data, break a relied-on client surface, or be difficult to contain after release.

**Delivery** is how reachable the behavior is now:

- **dormant** — no production caller, customer, or spending path can reach it.
- **gated** — a flag, allowlist, shadow path, or operator gate bounds who can reach it.
- **live** — the ordinary production path can reach it.

Consequence sets assurance depth. **Contained** covers the happy path, failure polarity, and expensive-to-reverse edges; **consequential** adds boundary failures, recovery behavior, and the strongest credible alternative; **critical** adds every material failure scenario realistic operation can produce (root `AGENTS.md` operating posture), operational evidence, and named rollback proof. That owed proof lands in the phase Verify blocks (each failure or recovery case as an AC-mapped check), with critical's rollback proof also carried in the Risks/Decisions register — not as free-standing narrative. Delivery sets rollout debt. **Dormant** names what keeps the path unreachable and the activation condition; **gated** names gate scope, defaults, authority, promotion evidence, rollback, and removal criterion; **live** carries the full rollout or migration contract below. A plan owes the union of both axes: *critical + dormant* still needs critical assurance, while *contained + live* still needs live rollout safety.

Every hard-to-reverse or contested decision carries a reversal condition and posture at every consequence and delivery level. The axes never waive that metadata. When either posture rises, update the declaration and back-fill the newly owed proof in the same PR.

Adoption is prospective for plan-contract obligations, these postures included: an obligation binds a plan authored or materially revised after it lands, never a backfill sweep of existing plans.

Tell: one label is being used to infer both impact and reachability → declare both axes and apply their obligations independently.

### Agent Brief

Put the task and stop conditions up front:

```markdown
**Agent brief.** Intent: ...
Source of truth: ...
Locked decisions: ...
Open decisions before build: ...
Current phase: ...
Stop-and-ask triggers: ...
```

Omit lines that are genuinely empty. Stop-and-ask triggers name human-owned decisions; ordinary implementation friction stays agent-owned. Keep the brief factual, not persuasive; it is the operating envelope for later implementation sessions. If a user, PRD, review, or plan names a source, link the exact source and expect the implementer to open it rather than search around it.

### Universal Posture

- **Declare shape mix, consequence, delivery, and PRD coupling in the first paragraph.** Standalone plans include a thin *Why* that names the structural reason to act, the do-nothing alternative, and rejected problem framings.
- **Goals are falsifiable; non-goals are real candidate scope rejected on purpose.** PRD-coupled plans inherit PRD success criteria; any extra plan-level goal is a PRD gap to surface.
- **One-screen system sketch up front.** Before detailed design, name the components, callers, state, and ownership boundary.
- **Sweep against the PRD when coupled.** Reference PRD contracts by name, never paraphrase. Divergence updates the PRD in the same PR or becomes an open question before implementation.
- **Directives name scope literally.** "Apply this," "verify this," and "keep this shape" state whether they bind one phase, every phase, all ACs, PRD-coupled plans, or only the current artifact.

### Contract-vs-Implementation Line

A plan earns the right to specify a name, schema, error class, retry policy, log shape, library choice, or file layout only when at least one is true:

- the decision is hard to reverse: data model shape, wire format, partitioning key, auth model, idempotency key
- it crosses an ownership boundary
- it encodes a non-obvious invariant: ordering, exactly-once semantics, consistency level, error taxonomy
- reasonable engineers or agents would diverge without it

Internal helper names, private class layout, ORM choices, validation libraries, and ordinary log lines live in code unless changing them would require updating consumers, runbooks, audit trails, or downstream artifacts.

### Detailed Design

For every contract-bearing surface, specify only what consumers need:

- **External names**: wire fields, DB columns, URL paths, event names, error codes, metric labels.
- **Schemas**: relationships, cardinalities, mutability, uniqueness, ordering, and load-bearing types such as money precision or timezone semantics.
- **Errors**: stable error classes, when each fires, retry posture, and consumer responsibility.
- **Writes**: idempotency status, key derivation, key lifetime, and conflict behavior.
- **Compatibility**: additive vs breaking changes, deprecation window, and what consumers can rely on across versions.
- **Auth**: role model for user-facing surfaces or service auth mechanism and 401/403 behavior for service surfaces.
- **Acceptance criteria**: unique AC IDs plus examples or named scenarios. EARS-style phrasing is the default: "When <trigger>, the system shall <response>." Merge ACs whose scenarios cannot distinguish them.

### Alternatives

The section is required when the plan carries design-doc/RFC shape and optional when the design is settled upstream. The discipline is still required: a non-trivial plan with no rejected approach is usually asserting the design rather than choosing it.

Use 2-4 real alternatives. Include the obvious approach even when rejected. Each alternative names the concrete shape, trade-offs against the goals, and why rejected given those goals. Build effort is not a rejection axis; reject on reversibility, ownership cost, outcome risk, validation sharpness, or a measured spike. Spike only uncertainties a prototype can decide; don't prototype around questions that require data, customer feedback, permission, operator capacity, or real-world outcome evidence.

Omit alternatives for mechanical refactors and well-trodden conformance changes. A performative alternatives section is worse than none.

### Rollout And Migration

Delivery determines the section's weight (§ Consequence And Delivery). A **dormant** plan names what keeps the path unreachable and the activation condition. A **gated** plan specifies gate scope, defaults per environment, who can change it, promotion evidence, rollback, and removal criterion. A **live** plan specifies the full rollout or migration sequence. Consequence can add proof but never remove these delivery obligations.

Phases advance on observable criteria, not dates. Each rollout phase names what changes, the gate to advance, and the rollback path.

For data or interface migrations, use the Expand -> Dual-write -> Backfill -> Read-cutover -> Contract vocabulary unless a deviation is justified. Each step names source of truth, drift policy, and advance criterion. Backfills name row/time bounds, expected duration order of magnitude, checkpointing, idempotency, and observability. Feature flags name scope, defaults per environment, who can flip them, and removal date or criterion. Migration scaffolding that lacks a scheduled Contract phase is unfinished.

Reproduce-then-retire gates must name the committed reproduction inputs and verify they are tracked. If a component is reimplemented rather than ported byte-for-byte, gate on port-faithfulness against the retained reference, not exact output reproduction.

### Cross-Cutting Concerns

Add a concern only when it is load-bearing for this plan. Boilerplate is a false signal of review.

- **Observability**: SLI/SLO, alert threshold, dashboard/log/metric contract, and debug path.
- **Security/privacy**: threat model, auth/authz changes, data classification, encryption, audit logging, and named review gate.
- **Performance**: P50/P99, throughput, cost target, steady-state and burst load, and overload behavior.
- **UI/deck visual direction**: for plans that produce a UI, deck, or visual deliverable, specify a concrete direction before build or require 3-4 distinct options before implementation. Do not let a default model house style choose for the artifact.

### Risks, Decisions, And Questions

Risks are runtime failure modes with mitigations. Open questions are undecided design. Disconfirming signals are bet-falsifiers; PRD-coupled plans route them upstream, while standalone plans may carry them under *Risks*.

Decisions and open questions are sibling lists:

- **Decisions** pair every hard-to-reverse or contested commitment with a reversal condition and posture — *reversible on first-release evidence*, *reversible on later experience*, or *structural / no planned reversal*. Routine reversible choices may stay in the chosen approach without duplicating the list.
- **Open questions** declare dependency type: *needs-data*, *needs-decision*, or *needs-tracking*. More open questions than decisions means discovery doc, not implementation-ready plan. An open question that must close before build additionally names the evidence that settles it, the phase producing that evidence, the phase before which it is due, and its ruling owner; once ruled, replace the row with the ruling.
- **Warrants match reversal cost** — evidence, reasoning, or declared conviction; when the warrant falls short of that cost, make the decision reversible, defer it to named evidence, or pause before implementation.

### Premise Anchors

A load-bearing repository or system fact the plan's approach rests on is an **anchor**: state it with a revalidation probe — the command, query, or path check that re-verifies it — and recheck it at phase entry. An invalidated anchor is a broken premise, routed per [`../IMPLEMENTATION.md`](../IMPLEMENTATION.md) § Divergence And Re-Plan, never silently patched.

### Implementation Phases

Contract-bearing build phases use the `### Steps` / `### Verify` / `### Exit criteria` shape templated in [`../AGENTS.md`](../AGENTS.md) § Decisions and contracts.

A worklist or per-file inventory in a phase is either derived — name the command or recipe that regenerates it, plus the invariant proving the derivation complete — or declared **fixed**: a bound enumeration nothing regenerates, such as a frozen migration file set. Every derived recipe runs at phase entry and its result replaces the authored snapshot; an undeclared or unrun inventory is stale by construction. A recipe suffices only when it is mechanical — judged against the weakest agent class expected to execute the phase; regeneration that still needs author-level judgment exposes a missing plan decision.

Tasks are scoped by exit criteria, not hours. Each phase names the tests it introduces or makes pass; "we will add tests" is not a Verify item. The final phase's Verify block includes any integration scenario needed to prove the plan-level success criteria. Shared-code phases include suite-level commands. If a phase temporarily skips a test, a later phase must explicitly re-enable it.

Mark parallelizable steps with `[P]`. If a phase has three or more independent read, verify, or exploration tracks, name the fan-out targets explicitly; do not rely on the agent inferring parallelism from prose.

When phases are not strictly linear, declare the edges explicitly — a short "Phase N: after M" list — and omission reads as linear order. The declared edges, not prose adjacency, decide which phases wait and which may run in parallel.

## Out Of Scope

Plans route, rather than absorb:

- product thesis and bet conviction -> parent PRD
- commercial framing -> `business/gtm/`
- customer-by-customer rollout choreography, owners, staffing, and dates -> roadmap artifacts
- internal mechanics below contract surface -> code
- strategy/pillar positioning -> `business/strategy/`
- runbook content -> the owning runbook, or a named runbook gap
- methodology/reference docs -> next to the code or domain they describe
- investigation artifacts and generated optimization plans -> `python/investigations/` or the generated-data home

When no redirect target exists, name the gap instead of hiding the content in the plan.

## Failure Modes

The always-on guards in [`../AGENTS.md`](../AGENTS.md) § Failure Guards (altitude, testing-in-Verify, migration scaffolding, trigger-anchored re-plan, literal scope, runnable-deliverable verification, …) apply on top of this list and are not restated here.

- **Spec-as-roadmap.** Tell: features and dates, no contracts. Fix: separate roadmap from plan.
- **Spec-as-postmortem.** Tell: alternatives are ceremonial because code already decided everything. Fix: write before build or relabel as a design record.
- **Everything-is-open-question doc.** Tell: open questions outnumber decisions. Fix: declare discovery/design-doc shape or close questions before requesting build review.
- **Boilerplate concern.** Tell: "handled appropriately" with no mechanism. Fix: omit the concern or name the mechanism.
- **Decision-laundering.** Tell: alternatives are one-sided and approval is fast because the meeting already decided. Fix: reopen the decision or record a design record, not a plan.
- **Template-as-cargo-cult.** Tell: every section is filled regardless of relevance. Fix: omit sections that are not load-bearing.
- **Frankenstein contract.** Tell: a deterministic AC gates on an LLM/learned judgment, classification, grade, or exact fitted magnitude. Fix: gate on structural inputs/outputs, assert invariants such as identity/order/sign/conservation, or route the learned value to prose/ranking/human review. Narrow independent verifiers are allowed when they return a schema-versioned closed enum and have an explicit failure polarity: error-falls-to-no-op or error-falls-to-reject.
- **Coverage overshoot** *(internal tooling only).* Tell: verification machinery exceeds what the human review needs. Fix: stop at the human-in-loop bar.
- **Premature supersession by adjacent plan.** Tell: this plan claims a sibling delivers an AC without checking it. Fix: cross-link the exact ACs each plan owns.
- **Structural non-conformance.** Tell: a new contract-bearing plan uses legacy `## Phase N tests` / `## Phase N gate` instead of `### Verify` + AC IDs. Fix: use the canonical phase shape.

## Author Self-Check

Before requesting review:

1. Altitude first: premise, reducibility, root cause, shape, and size hold; do-nothing and the obvious approach were weighed.
2. Frontmatter declares status; the preamble declares shape mix, consequence, delivery, and PRD coupling; the Agent brief follows.
3. Lightweight plans justify why the full harness is disproportionate and still satisfy both posture declarations, sticky-decision metadata, phase proof, and lifecycle.
4. PRD-coupled plans reference PRD contracts by name and propagate divergence.
5. Contract requirements have AC IDs plus examples or named scenarios.
6. Testing lives in phase *Verify* blocks, not a trailing section.
7. Cross-cutting concerns are load-bearing and concrete.
8. Every hard-to-reverse or contested decision has reversal condition and posture; every open question has dependency metadata.
9. Migration scaffolding has a removal date or criterion, and tracked reproduction inputs are named.
10. Scope redirects point to real artifacts or name a gap.
11. Failure modes above and the [`../AGENTS.md`](../AGENTS.md) § Failure Guards have been swept by name.

## Files And Frontmatter

Placement and naming live in [`../AGENTS.md`](../AGENTS.md) § Placement.

Structured initiative directories are optional. Use them only when the planning trace has reuse value: multi-session research, measured spikes, or deeply worked rejected approaches. Keep process beside the plan, not inside it. `sources/` are frozen inputs, `journal.md` is append-only reasoning trace, and `discarded/` holds worked rejected approaches too detailed for *Alternatives*.

Every plan carries:

```yaml
---
status: active          # active | done | abandoned | deferred
created: 2026-04-29
updated: 2026-04-29
---
```

Update `updated:` on substantive content edits and `status:` on lifecycle change.

## Lifecycle

1. **Create**: place the plan, add frontmatter, declare shape mix, consequence, delivery, and PRD coupling, then draft the Agent brief, system sketch, and contract surface before phase breakdown.
2. **Work**: before a phase, read [`../IMPLEMENTATION.md`](../IMPLEMENTATION.md). Contract-level discoveries update the plan in the same PR; ordinary mechanism choices remain implementation-owned.
3. **Complete an implementation plan**: run the completion retro ([`../IMPLEMENTATION.md`](../IMPLEMENTATION.md) § Completion Retro), set `status: done`, then archive or delete in the merging PR.
   - **Archive** plans whose reasoning remains useful: RFC/design shape, rejected alternatives, sticky rationale, non-obvious phasing, or initiative companions.
   - **Delete** pure impl plans whose value is fully captured by merged code and whose implementation left no reusable lesson.
   - Default when ambiguous: archive.
4. **Maintain a governing index**: keep `status: active` while the artifact still owns current sequencing or routes unfinished child plans. Reconcile completed children and stale links, but do not mark the index done merely because one implementation plan completed. When its governing job ends, run the retro and archive it; do not delete durable cross-plan rationale.
5. **Abandon/defer**: set terminal status with a one-line reason, then move to `.archive/`.

A lightweight plan is the same contract at minimum weight: frontmatter; a one-line preamble declaring why it qualifies plus shape mix, consequence, delivery, and PRD coupling; an Agent brief; every hard-to-reverse or contested decision with reversal metadata; and one contract-shaped phase with Verify and exit criteria. It may omit sections that add no load-bearing content, but it does not waive rollout obligations or lifecycle.
