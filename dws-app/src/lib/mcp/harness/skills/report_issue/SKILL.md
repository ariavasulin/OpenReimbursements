---
name: report_issue
description: >-
  Use when an employee wants to report a problem, request an improvement, or
  submit a question about the DWS application, photos, receipts, connector, or
  workflow, including checking an earlier report whose publication is uncertain.
---

# Report a DWS issue

Turn what the employee knows into a useful report, then publish only after
they confirm the exact text. Use the script descriptions and argument schemas
returned with this skill. No SMS login or browser session is required.

## Prepare and confirm the report

Draft a concise title and body with the available summary, reproduction steps,
expected and actual behavior, impact, and relevant job or page context. Choose
the appropriate issue kind. Ask only for missing facts that would make the
report useful; do not demand details the employee cannot know or invent a
diagnosis.

Unless the employee explicitly requests anonymity, ask for the reporter's name
if it has not already been supplied. For an attributed report, include
`Reported by: <name>` in the final body shown to the employee. This name is
self-reported attribution, not authenticated identity.

Show the exact final title and Markdown body, including the attribution choice,
and obtain explicit confirmation. Only then call `create_github_issue` with
`confirmed: true`. Send the report body and reporter name separately: omit the
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
supply alternative targets. This workflow publishes reports and checks their
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
