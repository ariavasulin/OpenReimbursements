# Implementation preflight — 2026-09-07

Status: **preflight passed; CLI access and both MCPs verified in Claude and Codex**. The user authorized setup and authentication checks, with implementation to begin only on later instruction. No implementation, deployment, schema mutation, or photo mutation was performed.

| Check | Evidence / outcome |
|---|---|
| Baseline | Commit `142b09c80977c25206ff6883294aa54326efb0d5`; branch `ariavasulin/Picasa-Migration` |
| Runtime | Node `22.23.1`, npm `10.9.8`; Vercel CLI `59.1.4`; Supabase CLI `2.115.0` |
| Dependencies | `npm ci --no-audit --no-fund` completed using the existing lockfile |
| Unit tests | `npm test` from `dws-app`: 26 files, 207 tests passed |
| TypeScript | `npm exec -- tsc --noEmit --incremental false -p tsconfig.json` from `dws-app`: exit 0 |
| Docker | Started installed Docker Desktop; daemon `29.5.3` responds; no containers running at check time |
| Vercel CLI | Authenticated as `ariavasulin`; verified existing project `dws-receipts`, root directory `dws-app`, configured Node `22.x`; linked this repository root locally |
| Supabase CLI | Saved login successfully lists healthy project `Receipt App` (`qebbmojnqzwwdpkhuyyd`) when the invalid inherited token override is removed |
| Application credentials | Pulled Vercel development variables into ignored `dws-app/.env.local`, mode 0600. Auth health, an empty HEAD query of photos with service-role credentials, and photos-bucket metadata each returned HTTP 200; no photo contents fetched |
| Storage configuration | Existing `photos` bucket is public; object limit `53687091200` bytes (50 GiB) |
| GitHub CLI | Authenticated as `ariavasulin`; existing token supports repository operations. This is not the future Issues-only application credential |
| Claude Code | Existing Claude subscription login works; Vercel and Supabase MCP health checks connected after browser authorization; actual project reads passed in a fresh Claude process |
| Codex/Orca MCP | Added HTTP `vercel` and project-scoped `supabase` entries to the effective global config. Standard `~/.codex/config.toml` resolves to Orca's runtime config. Both report `o_auth`; actual project reads passed in a fresh Codex process |

## Local setup changes

- Removed the invalid `SUPABASE_ACCESS_TOKEN` export from `~/.zshrc`; its value matched the inherited value rejected by the CLI. Saved the original file in `~/.zshrc.preflight-20260907.bak` with mode 0600. Existing processes can retain the stale environment: use `env -u SUPABASE_ACCESS_TOKEN supabase ...` until their environment is refreshed. No valid saved CLI credential was replaced.
- Vercel link created ignored `.vercel/` metadata and a root `.env.local` containing its development OIDC token. Vercel appended `.vercel` to the repository ignore rules. Both environment files have mode 0600; no credentials belong in commits.
- Installed dependencies locally and started Docker Desktop. The isolated Supabase stack, schema bootstrap, and new integration/browser harnesses remain Phase 1/3 implementation work.

## Authentication verification

The original callback listeners timed out. Restarted all three login flows after the user returned; **Codex Vercel**, **Codex Supabase**, and **Claude Supabase** then reported successful authentication. Verified actual tool calls in fresh processes with access limited to the two read operations below; both processes exited successfully.

| Runtime | Vercel `get_project` | Supabase `get_project_url` |
|---|---|---|
| Claude Code | Success: `dws-receipts`, project `prj_88wyiltek8eTbBPLGzg4EsiFKOAR` | Success: `https://qebbmojnqzwwdpkhuyyd.supabase.co` |
| Codex | Success: `dws-receipts`, project `prj_88wyiltek8eTbBPLGzg4EsiFKOAR` | Success: `https://qebbmojnqzwwdpkhuyyd.supabase.co` |

For future reauthentication, run from this workspace:

```sh
codex mcp login vercel
codex mcp login supabase --scopes organizations:read,projects:read,projects:write,database:write,database:read,analytics:read,secrets:read,edge_functions:read,edge_functions:write,environment:read,environment:write,storage:read,storage:write
claude mcp login supabase
```

Run Claude login in an interactive terminal. Codex's first automatic Supabase registration failed because its inferred scope list contained unsupported values; the explicit scope list above completed authorization successfully. The original running Codex session's tool catalog has not acquired these tools, but newly initialized processes load and use them successfully. Start implementation workers with a newly initialized session.

## Implementation boundary

Vercel **development** variables target the live Supabase project. They are not an isolated test backend. Phase 1 must explicitly configure the disposable local stack and prevent the test harness from inheriting these credentials; no database reset or fixture seed may target the live project. No production Supabase CLI link was created in this worktree.

The existing baseline passes despite dependency-install warnings about the pinned Next.js release and a Node-types peer range. No dependency upgrades were made during preflight. The future MCP shared key, Issues-only application credential, production canonical mapping, and activation evidence remain the plan's later obligations.

Setup references: [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), [Vercel MCP](https://vercel.com/docs/agent-resources/vercel-mcp), and [Supabase MCP](https://supabase.com/docs/guides/ai-tools/mcp). Read on 2026-09-07; observed local results above govern readiness.
