# Plans

Plans, design docs, and RFCs. Always-on routing layer. Authoring guidance lives in [`refs/authoring.md`](refs/authoring.md); implementation discipline lives in [`IMPLEMENTATION.md`](IMPLEMENTATION.md).

## Read Triggers

- Before drafting or materially revising a plan, read [`refs/authoring.md`](refs/authoring.md) end-to-end.
- Before implementing a plan phase, read [`IMPLEMENTATION.md`](IMPLEMENTATION.md).
- When a user, plan, review, or PRD names a file, URL, artifact, command, or output, fetch that exact source before synthesizing. Search, memory, and summaries are not substitutes.
- When a PRD-coupled plan diverges from the PRD, update the PRD in the same PR or name the divergence as an open question before implementation.
- When a revision is triggered by a new input, rank the plan decisions by blast-radius before editing; the trigger scopes what to revisit, not the ceiling.

## Always-On Plan Contract

Plans are mechanism-precise build commitments, not aspirational narratives. A competent engineer or agent should be able to build from the plan alone at the decision level — every judgment call made or routed, completion falsifiable at the contract surface. Worklists and per-file inventories are not plan content: derive them from the checkout at execution time (name the recipe), or declare the enumeration **fixed** when nothing regenerates it; an undeclared inventory goes stale silently. A `fixed` declaration binds only the enumeration on its own line or `;`-clause, so put the declaration on the line carrying the paths it freezes — a `*(fixed enumeration)*` in a section heading above a list does not freeze the list.

A phase is the normal execution unit; once ready, run it continuously to its exit criteria without recurring approval gates.

Every plan declares its shape mix in the preamble: **design doc / RFC** (should we do this), **tech spec** (what is the contract), **implementation plan** (what lands in what order and how it is proven). It also declares two independent ordered postures: **consequence** — *contained*, *consequential*, or *critical* — and **delivery** — *dormant*, *gated*, or *live*. Consequence sets assurance depth; delivery sets rollout obligations. The definitions, the section each posture owes, and the prospective adoption scope live in [`refs/authoring.md`](refs/authoring.md) § Consequence And Delivery.

The harness is proportional. Lightweight plans declare why there is no new contract surface, cross-artifact dependency, or meaningful implementation ambiguity.

## Placement

File plans at the narrowest scope that covers every module they touch:

- scoped to one module → `active/<module>/`
- spanning multiple modules → `active/<initiative>.md` or `active/<initiative>/plan.md`
- exploratory planning with durable process trace → optional initiative directory with `sources/`, `journal.md`, and `discarded/`

Filenames are `kebab-case.md`; no `_plan` suffix. Existing `active/` plans are reference material, not templates.

Investigation-triggered plans live under `python/investigations/...`, not top-level `plans/`; they still follow this contract.

<!-- The headings "Lifecycle", "Decisions and contracts", and "Execution shape" are pinned by exact string from the out-of-repo pepr-ai/peprkit plan-review gate (its refs/review/profiles/plan-review.md and plans/IMPLEMENTATION.md reference `plans/AGENTS.md § <heading>`). That consumer cannot be edited from this repo, so renaming any of the three silently makes its altitude / plan-freshness / shared-editing-surfaces gate resolve to a missing section. Keep the strings if you resection. -->

## Lifecycle

Plans are created in `active/` and worked continuously. A completed implementation plan is archived or deleted in the merging PR — archive when the reasoning has reuse value, delete when merged code fully captures it, default archive. An active governing index remains active while it still owns current sequencing or routes unfinished child plans; completion of one implementation plan does not retire that index. Abandoned or deferred plans take a terminal status and move to `.archive/` with a one-line reason. A deleted plan remains recoverable from git history only when it landed on the base branch before the PR that deletes it — added and deleted inside one squash-merged PR, it leaves no trace, so land it first. Stages and the completion retro live in [`refs/authoring.md`](refs/authoring.md) § Lifecycle. Advisory hygiene: `scripts/check-plan-staleness.py` (from repo root) flags plan-cited paths that once resolved and no longer do. To exempt a plan whose citations are a deliberately dated record, place `<!-- staleness-exempt: <reason> -->` on the line just below the frontmatter close; the reason is required and the marker is honored in every mode.

## Decisions and contracts

Sticky calls are surfaced, not buried: every hard-to-reverse or contested decision carries its reversal condition and posture ([`refs/authoring.md`](refs/authoring.md) § Risks, Decisions, And Questions). Put them in the Decisions list; a lightweight plan may state each once in its chosen approach instead, with the same metadata.

A plan specifies a name, schema, error class, retry policy, or log shape only when the decision is hard to reverse, crosses ownership, encodes a non-obvious invariant, or reasonable agents would diverge. Internal names and code-private layout live in code.

Contract requirements use AC IDs (`AC-1`, `AC-2`, ...) plus examples or named scenarios, covering behavior within realistic operation (root `AGENTS.md` operating posture) — contrived inputs earn neither an AC nor a phase. Traceability closes in both directions: every AC advances a plan goal and appears in a phase Verify block where the code lands, and every phase advances an AC or names itself required scaffolding. Keep AC-evidence probes such as grep patterns and line anchors in phase Verify blocks, not AC prose.

Contract-bearing build phases use `### Steps`, `### Verify`, and `### Exit criteria`:

```markdown
## Phase N — <name>

What this phase establishes, why it is next, what it defers.

### Steps
1. <concrete deliverable>

### Verify
- [ ] [AC-1] <scenario or command>
- [ ] <existing suite still green for touched modules>

### Exit criteria
Observable state proving completion.
```

## Execution shape

A plan delivered across more than one PR names, per PR, the contract that PR owns — the surface it makes callable or the invariant it establishes — so a reviewer bounds each PR's blast radius without reading the siblings, and names the merge order: which PR lands first and what breaks if they land out of order. For every surface more than one of those PRs edits (a schema, registry, config file, shared module, or doctrine doc), name three things: the **sectioned-output boundary** that lets the PRs edit it without colliding — an owned section, record, or file per PR — so the merge is mechanical rather than a hand-resolved conflict; which PR is its **source of truth**; and how a later PR **rebases** onto an earlier one's version. A single-PR plan owns one contract by construction and writes none of this.

## Failure Guards

- **Altitude before build.** Tell: the plan starts from a chosen implementation while the premise, reducibility, root cause, shape, or size is still unsettled. Fix: resolve that altitude first; high-reversal decisions need ratification before build.
- **Over-assured plan.** Tell: a plan carries machinery neither its declared consequence nor its delivery level owes — critical-grade failure matrices on a *contained* plan, staged rollback proof on a *dormant* one. Fix: strip it; raising the declaration honestly is the alternative.
- **Alternatives are real when design is still live.** Tell: a non-trivial plan names no rejected approach, or the obvious approach is absent. Fix: compare the viable approaches against the plan's goals before deciding; the full alternatives rubric lives in [`refs/authoring.md`](refs/authoring.md).
- **Testing lives in phase Verify blocks.** Tell: a trailing "Testing" section says tests will be added later. Fix: move scenarios to the phase that introduces the behavior and tag AC IDs.
- **Migration scaffolding contracts.** Tell: dual-write/shim/compatibility/reproduce-then-retire code ships without removal criterion or tracked reproduction inputs. Fix: schedule Contract, name the retained source, verify tracked inputs. Scaffolding is earned only at the durable-state boundary the root `AGENTS.md` backward-compatibility bullet declares; in-repo interfaces evolve in place.
- **Frankenstein contract.** Tell: an AC or deterministic gate keys on an LLM/learned grade, classification, judgment, or exact fitted magnitude. Fix: gate on structural properties or route the value to prose/ranking/human review; carve-outs live in [`refs/authoring.md`](refs/authoring.md).
- **Trigger-anchored re-plan.** Tell: a new input changes one surface and the re-plan starts there while higher-blast-radius decisions go unasked. Fix: rank decisions by blast-radius, then edit.
- **Literal scope leak.** Tell: a directive/rule is demonstrated once or says "apply/verify/keep this shape" without naming scope. Fix: state the scope explicitly.
- **Runnable-deliverable verification.** Tell: a runnable gate / command / report / CLI is verified only through unit tests. Fix: run the entry point and assert its artifact.
- **Deferred confirmation gets a watch, not prose (anomaly-engine plans).** Tell: an **anomaly-engine** plan phase's Verify/exit criteria include a post-deploy, day-N, or multi-week confirmation with no executor — "confirm after deploy", "verify on day 1", "accumulate then confirm". Fix: before merge, register a watch row in `python/evals/anomaly/health/watches.jsonl` — an executable kind when the history-log mirror can evaluate it, a `manual` row otherwise, whose `source` must reference the shipped PR/commit (deferred verification of *shipped* code, not a future-feature reminder). An obligation with no definite due condition or confirm action — or a plan in another area, which the anomaly register cannot hold — stays a named board item until a register exists for it. Canonical home + kinds: [`../python/evals/anomaly/health/AGENTS.md`](../python/evals/anomaly/health/AGENTS.md); paired with the engine-side guard (`python/src/anomaly/AGENTS.md` § Key Patterns) — keep the two in sync on any check-kind change (couple-at-both-ends; no central registry).

## Out Of Scope

Plans do not absorb product thesis, commercial framing, customer-by-customer rollout choreography, staffing/dates, internal mechanics below contract surface, strategy positioning, runbooks, or methodology refs. A `live` plan still owns its own rollout/migration sequence and gates (§ Consequence And Delivery); what is out of scope is the customer-by-customer and commercial choreography around it. Route those to the owning artifact; [`refs/authoring.md`](refs/authoring.md) carries details.
