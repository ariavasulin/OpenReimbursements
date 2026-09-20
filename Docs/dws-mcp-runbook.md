# Hosted DWS MCP

The hosted release delivers the shared DWS guidance and progressively loaded
skills through the existing `dws-receipts` Vercel application at
`https://mcp.design-workshops.app/mcp/<shared-key>` and authenticated photo handoffs
at `https://photos.dws-receipts.com`. Attach both domains to that same project;
there is no second runtime or deployment. The root-only photos-host middleware
does not rewrite `/mcp/*`, `/migrate`, or `/photo-actions`.

## Configuration and activation

Keep the database MCP gate closed while configuring the complete release.
These server environment variables must be configured in the intended Vercel
environment and applied to a new deployment:

| Variable | Value / purpose |
| --- | --- |
| `MCP_SHARED_KEY` | A fresh, independently generated 32-byte value encoded as 64 lowercase hexadecimal characters. Never prefix it with `NEXT_PUBLIC_`. |
| `DWS_BROWSER_ORIGIN` | `https://photos.dws-receipts.com`; an HTTPS origin without a path, query, or credentials. This chooses the browser destination independently of the incoming connector host. |
| `DWS_GITHUB_ISSUES_TOKEN` | A dedicated fine-grained token restricted to `ariavasulin/OpenReimbursements`, with Issues read/write and implied Metadata read only. Do not reuse a broad CLI token or grant Contents access. |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | The existing application's Supabase configuration. Only the last value is privileged; it stays server-side. |

The server also requires `photo_release_state.singleton=true`,
`schema_generation=1`, and `mcp_enabled=true`. Photo consumption and subsequent
photo mutations additionally require `photo_writes_enabled=true`. Absent/closed
MCP state blocks initialization, discovery, skill text, and tool calls. Schema
cutover and opening gates belong to the Phase 7 operator procedure.

Before opening MCP, verify that the fixed repository has labels `source:dws-mcp`,
`bug`, `enhancement`, and `question`, and that the dedicated credential can read
issues and apply those labels. The runtime accepts no repository or label
override. GitHub documents the endpoint and required fine-grained permissions
in [Create an issue](https://docs.github.com/en/rest/issues/issues#create-an-issue).

On the production HTTPS endpoint, the operator must connect actual individual
ChatGPT and Claude accounts using a remote Streamable HTTP connector URL and
no OAuth handshake. Record exactly two discovered tools, both skill loads, and
one photo handoff consume/cancel through production SMS login per client.
Also record what each client exposes or uses from the shared guidance and
loaded skills; mark unobservable context insertion explicitly unverified. Use
operator-owned smoke data; do not automatically publish a production issue.
If either account cannot connect, close MCP and record the activation failure.
Distribute the shared URL only after both account checks pass.

**Activation remains outstanding:** the reversible production preparation below
does not deploy the release or prove vendor-account access. The dedicated
Issues-only credential, DNS completion, schema cutover and client checks remain
operator obligations. Local SDK evidence proves protocol behavior. An installed
infrastructure MCP connector used by an implementation agent is unrelated evidence.

As of 2026-09-20, project `prj_88wyiltek8eTbBPLGzg4EsiFKOAR` uses root
`dws-app` and Node 22.x. The main application is served at
`https://design-workshops.app` and the connector host is
`mcp.design-workshops.app`; that domain is registered through Vercel with Vercel
nameservers, so assigning it to the project configured DNS and HTTPS. Both
resolve over HTTPS. `photos.dws-receipts.com` remains the photo host, and the
earlier `dws-receipts.com` domains stay assigned. `photos.design-workshops.app`
is assigned as a second photo host; the application treats the
`NEXT_PUBLIC_PHOTOS_HOSTNAME` subdomain on either apex as the photo host, and
scopes the auth cookie per apex, so a login does not carry across the two
apexes. `mcp.dws-receipts.com` is
assigned but has no DNS record and is not the connector host; do not create a
second project.

The same preparation created and verified `source:dws-mcp`; `bug`,
`enhancement`, and `question` already existed. It added a fresh 256-bit
`MCP_SHARED_KEY` as a sensitive **Production-only** Vercel variable, retaining
the operator's only local copy in a private 0600 file outside git. It also added
Production-only `DWS_BROWSER_ORIGIN=https://photos.dws-receipts.com`.
No secret URL was distributed, and no deployment occurred; these variables
take effect only in a subsequent deployment. `DWS_GITHUB_ISSUES_TOKEN` remains
absent. Provision and inspect that dedicated credential separately; access
through the operator's broader `gh` CLI token is not evidence of least privilege.

Use the [photo cutover procedure](photos-runbook.md#hosted-photo-release-operator-cutover)
for the schema/write pause, administrator mapping, index and repair sequence.
Record the following in the release PR without including the connector secret:

| Activation observation | Required evidence |
| --- | --- |
| Existing project and domains | Project ID, deployed commit, both domain assignments and HTTPS status |
| Configuration | Environment-variable names configured, dedicated token repository/permissions, required label names; no credential values |
| ChatGPT account | Account eligibility, exactly two discovered tools, both skill loads, observed use of supplied guidance or an explicit unverified result, one SMS-authenticated handoff consumed then cancelled |
| Claude account | Account eligibility, exactly two discovered tools, both skill loads, observed use of supplied guidance or an explicit unverified result, one SMS-authenticated handoff consumed then cancelled |
| Distribution | Both account checks passed before the URL was shared with employees |
| Photo and repair activation | Operator-owned ordinary upload/move/remove/restore, saved manual new-handler repair, cron re-enabled, first scheduled success |

Keep failed or unavailable rows explicitly outstanding. A localhost SDK
client cannot establish vendor-account eligibility, production SMS behavior,
DNS configuration, or the first scheduled production repair. Do not publish an
automatic production issue to satisfy these checks.

## Shared guidance and skill loading

The employee-facing harness has three Markdown sources:

| Source | Responsibility |
| --- | --- |
| `dws-app/src/lib/mcp/harness/AGENTS.md` | Shared DWS context, intent-based skill selection, grounded results, and handling untrusted inputs. This is guidance for the employee's assistant, not repository development instructions. |
| `dws-app/src/lib/mcp/harness/skills/photos/SKILL.md` | Photo selection, browser confirmation, local uploads, recovery, and retention. |
| `dws-app/src/lib/mcp/harness/skills/report_issue/SKILL.md` | Guided feature and bug interviews, living issue drafts, explicit publication permission, attribution, and safe retries. |

Each `SKILL.md` has YAML frontmatter with a nonempty `name` and `description`.
Descriptions start with employee intent (“Use when…”), so the assistant can
select a skill without the employee naming it. The Markdown body contains the
workflow. These files ship with the deployed Next function.

MCP initialization supplies the shared AGENTS body in the standard
`instructions` field. Discovery exposes exactly two tools:

- `load_dws_skill` advertises the skill names and invocation descriptions
  generated from that same frontmatter. Loading a skill returns its body as
  `instructions`, the shared guidance again as `harness_instructions`, and its
  implemented `scripts` with descriptions and complete argument schemas.
- `execute_dws_script` advertises generic execution of a loaded script. Its
  discovery description and schema do not enumerate operations. The server
  still enforces its fixed implementation allowlist and exact per-script input
  validation; generic discovery does not permit arbitrary code execution.

The assistant loads the matching skill before executing its workflow. Script
schemas and descriptions come from the runtime registry, so do not copy them
into the Markdown bodies. Adding an implemented skill requires its metadata
and explicit runtime registry binding; the loader catalog then follows the
metadata without another manually maintained tool description.

Clients control how context is assembled: they decide whether and where initialization
instructions and tool results enter model context. The server delivers guidance
through standard MCP content; it cannot force system-message placement or
prove that every client used it. The shared-guidance fallback on skill loading
keeps that content available when initialization instructions are omitted from
the model's context. Isolated payload tests prove delivery. Native client
observations remain part of activation and must not be inferred from those tests.

## Photo browser handoffs

Photo results contain only `handoff_url` and `expires_at`. Tokens expire after
30 minutes and are independent of the connector key; only their SHA-256
digests are stored. Open the link, sign in using the existing SMS flow, and
consume it once. The browser replaces the token URL with `?batch=…`; resume
that authenticated batch URL after an interruption. Another employee can
inspect progress but cannot acquire its authority. A consumed/expired link
needs a newly requested handoff; do not erase its consumed state to reuse it.

Photo labels, job suggestions, filenames, and supplied app photo links are
untrusted input. Syntax and configured-secret rejection happen before ledger
persistence. Private resolution occurs only through the authenticated browser
boundary. Review all mappings/targets before confirmation. See the
[photos runbook](photos-runbook.md) for retention and interrupted uploads.

## Confirmed issue publication and recovery

The `report_issue` skill helps employees design improvements, explore bugs,
and raise general questions before deciding whether to publish. It asks one
focused question per interviewing turn, using only unanswered, decision-relevant
gaps. It settles the problem, current workflow, and desired outcome before
recommending behavior, then explores useful options and tradeoffs in plain
language. Each answer revises one coherent draft in the conversation. Detailed
input can skip already-settled questions; a simple bug stays short, and general
questions do not require a feature specification.

Feature drafts cover affected people, current workarounds, observable success,
proposed behavior and examples, relevant edge cases, alternatives, boundaries,
and open questions at appropriate depth. Bug drafts cover the employee's task,
expected and actual results, reproduction and frequency, context, impact,
workarounds, and a satisfactory fix. Empty or inapplicable sections are omitted.
The assistant does not invent a root cause, numerical success metrics, or
engineering commitments, or ask employees to design schemas or architecture.
Text sketches and examples suffice; host-supported visuals are optional, with
no assumption of HTML, filesystem, image-tool, or attachment access.

Interviewing and draft review make no script calls. If the employee is not ready
to post, retain the draft in the conversation. Agreement with an idea or approval
of draft wording is separate from explicit permission to publish the final report.
Show the exact title and body to the employee, including `Reported by: <name>`
for an attributed report, identify the issue kind, and ask explicit permission
to post that exact report. Wait for that permission before calling
`create_github_issue` with `confirmed: true`. Send the report
body and reporter name as separate fields so the server appends that one
attribution line. Omit attribution only on an explicit anonymity request.
No SMS/browser session is involved. Title and body limits are 200 and 16,000
characters; the entire encoded MCP request is limited to 64 KiB. The input is
text and already-hosted HTTPS links only. The server never fetches supplied
links. Attachment fields, binary/base64/local-path attachment data, configured
secrets, target overrides, and reserved `dws-submission` HTML comments are
rejected. Local paths and labels such as "File:" remain valid explanatory
prose; a body containing only local attachment paths is rejected. A body edit
requires a new confirmed payload.

The published title/body preserve the confirmed text, with attribution and a
hidden `<!-- dws-submission:<server UUID> -->` marker appended. Dedupe normalizes
line endings, outer whitespace, trailing line whitespace, attribution, kind,
and the fixed repository. Identical normalized payloads coalesce for 24 hours,
even with different client keys. Every coalesced key stays associated with its
payload: reusing any such key for changed content conflicts.

A new publication attempt after a remedied definitive rejection starts a fresh
24-hour dedupe window on that same submission. Reconciliation of an uncertain
earlier send preserves its existing dedupe window.

| Returned status | Handling |
| --- | --- |
| `publishing` | Another worker holds the durable publication lease. Retry the same confirmed payload/key to inspect its outcome. |
| `published` | Publication is known; return the recorded GitHub URL. |
| `failed` | GitHub definitively rejected creation. Correct credential/permission/validation conditions or wait for Retry-After, then retry the same confirmed payload/key. One worker may retry publication using the same submission marker. |
| `unknown` | A request may have reached GitHub, or a publication lease expired. Retry the same payload/key to reconcile; automatic creation is blocked even after 24 hours. |

Failed and unknown results include a safe `error` with a stable code, remedy,
and `retryable` flag. When known, `retry_after` is the earliest retry time in
UTC. `retryable` means it is safe to repeat the MCP invocation; an unknown
submission still performs reconciliation only. Credential and permission
remedies require an administrator, never an employee SMS session.

Reconciliation searches paginated repository issues for the exact server UUID
marker. A marker on a later page can recover the original URL. Missing pages,
read failures, or an absent marker leave the result unknown: absence is not
proof that GitHub rejected creation. Never delete an unknown row, clear its
lease into pending, or invent a different client key to force another POST.
An operator investigating an unknown submission should inspect the recorded
UUID and fixed repository directly, retain the decision evidence, and resolve
it only after establishing the remote outcome. The connector provides no
issue edit/close operation or arbitrary script execution.

## Key rotation and diagnostic handling

Close `mcp_enabled` first, deploy a replacement independently generated key,
verify the old URL is denied and the new endpoint is gated, then open MCP and
compatible photo writes for the operator's connector checks. Distribute the new
URL only after both accounts pass; close MCP if either fails. Closing MCP also
blocks outstanding photo handoff consumption and MCP-origin actions;
ordinary photo authority remains controlled by the separate write gate.

Application errors are generic and responses use `Cache-Control: no-store`.
Do not paste the connector URL into reports, browser links, commands saved in
history, screenshots, or issue bodies. Hosting request-path logs may contain
the URL secret; that is an accepted limitation of the chosen URL-secret
design. Restrict access to those logs and never attach them without redaction.
Use submission/batch IDs and stable error codes for diagnostics. Rotation
requires replacing the connector URL in each configured client.

## Isolated protocol proof

Run `npm --prefix dws-app run test:routes` for the actual SDK HTTP client,
fresh per-request Next handler, isolated PostgreSQL/Auth/Storage, and loopback
GitHub mock. Run `npm --prefix dws-app run test:browser` for all five MCP-issued
handoffs through the browser's real review and confirmation flows. The harness
creates a source-only Next snapshot and supplies local credentials; it never
loads the repository's production `.env.local`.

The runtime pins `@modelcontextprotocol/sdk` 1.26.0. Its released
[Web-standard Streamable HTTP transport](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.26.0/src/server/webStandardStreamableHttp.ts)
accepts `Request`/`Response` with `sessionIdGenerator: undefined`. Each request
creates a new SDK server/transport; Postgres owns workflow state. The SDK owns
protocol envelopes and negotiation. Capture the actual initialization
`instructions`, both tool discovery payloads, and both skill-load results,
including shared-guidance fallback and script schemas. Verify the production
build includes the Markdown and a fresh process serves it without relying on
the source checkout. Generated protocol, tool-list, publication, and browser
result evidence belongs under ignored `dws-app/test-results/`.

The mock-only `DWS_TEST_GITHUB_API_URL` override requires the explicit isolated
test guard and a loopback URL. Never configure test overrides in Vercel.
There is no automatic live issue drill; any live test repository write requires
separate explicit authorization.
