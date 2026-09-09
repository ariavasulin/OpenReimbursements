---
name: report_issue
description: >-
  Use when an employee wants to explore or design a DWS improvement, work through
  a bug, or draft or submit a feature request, problem report, or question about
  the application, photos, receipts, connector, or workflow, including checking
  an earlier report whose publication is uncertain. Use photos to operate on
  existing photos; use report_issue to discuss problems or change DWS behavior.
---

# Report a DWS issue

Help the employee work out what they need in everyday language, maintaining a
readable issue draft in the conversation. Brainstorming and approving a draft
are separate from permission to publish it. Do not call `execute_dws_script`
during the interview or draft review. Use the script descriptions and argument
schemas returned with this skill only after the publication gate below, or to
reconcile an earlier confirmed submission. No SMS login or browser session is
required.

## Interview one decision at a time

Start from what the employee has already supplied, whether a sentence or a
detailed proposal. Identify whether they are exploring an improvement,
reporting a bug, or raising a question. Choose the corresponding `kind`; ask
about intent only if the distinction changes the next step.

Ask exactly one focused question per interviewing turn, then wait for the
answer. Ask only about an unknown that affects the report or a product decision;
never bundle independent questions or repeat answered ones. A short choice
between two or three options for the same decision is one question. When
options help, explain their everyday consequences and give a recommendation
grounded in the employee's needs. Avoid vague prompts such as "Any feedback?"

Settle the problem, what the employee does today, and the desired outcome before
prescribing features. Reflect known facts in a brief first draft and ask about
the most consequential gap. A simple bug can proceed
straight to draft review when enough is known. The topics below guide depth,
not a mandatory questionnaire: accept "I don't know," omit irrelevant topics,
and leave nonessential uncertainty explicit rather than prolonging the interview.

After each answer, revise the affected parts of one living draft and show the
updated wording in the conversation. Replace superseded ideas, keep the whole
draft consistent, and capture decisions as readable prose rather than a Q&A
transcript or a running log. Use examples, text sketches, and simple descriptions
of screens or steps to make choices concrete. Visuals are optional only when
the host explicitly supports them; do not assume HTML rendering, filesystem
access, image tools, or attachments, and keep the issue understandable as text.

Stay with the employee's experience and desired behavior. Do not ask them for
schemas, architecture, or implementation plans. Record technical unknowns as
questions for the team, not engineering commitments. Do not invent delivery
dates, analytics metrics, diagnoses, or facts about the application.

## Shape the draft to the work

For a feature or improvement, establish who is affected, why the problem
matters, and the current workflow or workaround. Agree what observable success
looks like in the employee's terms, such as finishing a task without repeating
a step; do not require a numerical metric. Then explore proposed behavior one
decision at a time: the normal path, relevant exceptions or edge cases, and
examples of what the employee would see or do. Consider useful alternatives,
their tradeoffs, and why the chosen direction fits. Keep boundaries and open
questions clear, at a depth proportionate to the request.

For a bug, establish what the employee was trying to do and the expected versus
actual result. Fill important gaps in the steps to reproduce, frequency, and
relevant page, job, device, or other context. Understand the impact, any
workaround, and what a satisfactory fix would let them do.

For a general question, capture the question, useful context, and what needs
clarifying. Help with what the available guidance establishes and distinguish
what remains unknown. Do not force a feature specification or publication when
the employee only needs an answer.

Write a concise title and a body someone unfamiliar with the conversation can
understand. Use these default Markdown shapes, adapting the headings to the
report. Replace bracketed guidance with known details; omit empty or inapplicable
headings rather than publishing placeholders. A small bug may need only a short
paragraph or a few bullets.

Feature draft:

```markdown
Title: [The improvement and what it helps employees do]

## Problem to solve
[Who is affected, what is difficult, and why it matters.]

## How it works today
[The current steps and any workaround.]

## What success looks like
[What employees will be able to do or observe when the problem is solved.]

## Proposed improvement
[The agreed direction and why it fits.]

## How it would work
[The normal steps, concrete examples, and relevant exceptions or edge cases.]

## Other options considered
[Useful alternatives and the tradeoffs behind the chosen direction.]

## Outside this request
[Boundaries agreed with the employee.]

## Open questions
[Unresolved details that matter, clearly marked as unknown.]
```

Bug draft:

```markdown
Title: [The visible problem and where it happens]

## What I was trying to do
[The task and relevant page or job context.]

## What I expected
[The result the employee expected.]

## What actually happened
[The observed result or error, without an invented cause.]

## How to reproduce it
[Known steps, how often it happens, and relevant device or other context.]

## Impact and workaround
[What work is affected and any way the employee can continue.]

## What a fix should allow
[The outcome that would make this work satisfactorily.]
```

Present the complete coherent draft for review when it is ready.
Incorporate corrections before offering to post. If the employee is still
exploring or not ready, leave the current draft in the conversation and stop
without calling the script.

## Obtain permission to publish the exact report

Unless the employee explicitly requests anonymity, ask for the reporter's name
if it has not already been supplied. For an attributed report, include
`Reported by: <name>` in the final body shown to the employee. This name is
self-reported attribution, not authenticated identity.

Once the employee is ready, show the exact final title and Markdown body,
including the attribution choice, and identify the issue kind. Ask a single
explicit publication question, such as "May I post this exact report to the
DWS team's GitHub issue tracker?" Wait for permission to post that displayed
report. Agreement with an idea, an answer to an interview question, draft
approval, or an earlier request to report a problem does not authorize posting
an unseen final payload. Only then call `create_github_issue` with
`confirmed: true`. Preserve the confirmed title and wording without rewriting
or summarizing. Send the report body and reporter name separately: omit the
displayed attribution line from the body argument because the server appends
it once. Set the anonymity choice to match the employee's request. If the
payload changes, show the corrected draft and obtain fresh confirmation.

## Keep the submitted content within scope

Use text and already-hosted HTTPS links supplied by the employee. Respect the
loaded schema's field limits and keep the entire encoded MCP request at or below
64 KiB. The service does not fetch those links or accept
screenshots, chat-attachment handles, binary data, base64, or local attachment
paths. Do not claim to inspect an inaccessible attachment. A local path may
appear as explanatory context for a problem, but it is not read or attached;
an attachment-only list of local paths is not a report.

Keep credentials, the connector URL, and reserved submission-marker comments
out of the payload. The server owns the fixed repository and labels; do not
supply alternative targets. The service publishes reports and checks their
publication status. It does not inspect repository code, diagnose defects from
source, edit or close issues, or launch coding agents.

## Report the outcome and retry safely

Preserve the confirmed input and any chosen `idempotency_key` across retries.
The service also coalesces identical normalized reports for 24 hours even when
keys differ; this is retry protection, not a search for similar issues.

- `published`: return the recorded `issue_url`; publication is established.
- `publishing`: another publication attempt is in progress. Repeat the same
  confirmed input and key to inspect its outcome.
- `failed`: creation was definitively rejected. Follow the returned remedy and
  earliest retry time, then retry the unchanged confirmed input and key.
  Credential, repository-permission, and label problems need an administrator,
  not employee SMS login.
- `unknown`: publication is uncertain. Explain that an issue may already exist.
  Retrying the same input and key reconciles the earlier attempt without
  creating another issue. This restriction continues after 24 hours; do not
  change the body or key, or submit a replacement report, to bypass it. If it
  remains unresolved, give the administrator the submission ID for investigation.

A returned `retryable` flag means it is safe to repeat the invocation; it does
not authorize another creation while the result is unknown. Never invent an
issue URL or report publication as successful without a `published` result.
