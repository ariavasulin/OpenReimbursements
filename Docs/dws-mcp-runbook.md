# Hosted DWS MCP

The hosted release adds the connector to the existing `dws-receipts` Vercel application at
`https://mcp.dws-receipts.com/mcp/<shared-key>` and authenticated photo handoffs
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
one photo handoff consume/cancel through production SMS login per client. Use
operator-owned smoke data; do not automatically publish a production issue.
If either account cannot connect, close MCP and record the activation failure.
Distribute the shared URL only after both account checks pass.

**Activation remains outstanding:** the reversible production preparation below
does not deploy the release or prove vendor-account access. The dedicated
Issues-only credential, DNS completion, schema cutover and client checks remain
operator obligations. Local SDK evidence proves protocol behavior. An installed
infrastructure MCP connector used by an implementation agent is unrelated evidence.

As of 2026-09-07, project `prj_88wyiltek8eTbBPLGzg4EsiFKOAR` uses root
`dws-app` and Node 22.x; both domains are assigned and `photos.dws-receipts.com`
is verified. MCP ownership is verified, but **DNS remains unconfigured**.
An authorized DNS operator must add only
`CNAME mcp → 519bb06eece934dd.vercel-dns-017.com.` at the existing DNS provider
and run `vercel domains verify mcp.dws-receipts.com`. Keep the existing Google
nameservers; do not create a second project or change the registrar.
The available user login requires reauthentication and the application service
account lacks Cloud DNS permission; neither path changed DNS.

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
| ChatGPT account | Account eligibility, exactly two discovered tools, both skill loads, one SMS-authenticated handoff consumed then cancelled |
| Claude account | Account eligibility, exactly two discovered tools, both skill loads, one SMS-authenticated handoff consumed then cancelled |
| Distribution | Both account checks passed before the URL was shared with employees |
| Photo and repair activation | Operator-owned ordinary upload/move/remove/restore, saved manual new-handler repair, cron re-enabled, first scheduled success |

Keep failed or unavailable rows explicitly outstanding. A localhost SDK
client cannot establish vendor-account eligibility, production SMS behavior,
DNS configuration, or the first scheduled production repair. Do not publish an
automatic production issue to satisfy these checks.

## Registry and handoffs

Discovery exposes only `load_dws_skill` and `execute_dws_script`. Load `photos`
or `report_issue` to obtain instructions and the complete input schemas. The
dispatcher permits only these six names:

| Script | Result / next action |
| --- | --- |
| `migrate_photos` | `/migrate?token=…&script_name=migrate_photos`; select folders and review mappings. |
| `add_photos` | `/migrate?token=…&script_name=add_photos`; select up to 500 files and review job/sheet/tags. |
| `move_photos` | `/photo-actions?token=…&script_name=move_photos`; confirm exact photos and destination. |
| `remove_photos` | `/photo-actions?token=…&script_name=remove_photos`; confirm exact photos for 30-day trash. |
| `restore_photos` | `/photo-actions?token=…&script_name=restore_photos`; confirm eligible retained photos, optionally with a new destination. |
| `create_github_issue` | Durable submission ID/status, with a URL only after publication is known. |

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

Show the exact title and body to the employee, including `Reported by: <name>`
for an attributed report, and obtain explicit confirmation. Send the report
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
protocol envelopes and negotiation. Generated protocol, tool-list, publication,
and browser result evidence belongs under ignored `dws-app/test-results/`.

The mock-only `DWS_TEST_GITHUB_API_URL` override requires the explicit isolated
test guard and a loopback URL. Never configure test overrides in Vercel.
There is no automatic live issue drill; any live test repository write requires
separate explicit authorization.
