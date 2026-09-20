# OpenReimbursements

Guidance for coding agents working in this repository. `CLAUDE.md` is a symlink
to this file; edit `AGENTS.md`.

## Preflight: confirm CLI logins

Before starting work, check that both CLIs are logged in. Deployment, domain,
database, and cutover steps in `Docs/` depend on them, and a missing login
otherwise surfaces late as a confusing `Unauthorized` error.

```bash
vercel whoami            # expect a username
supabase projects list   # expect a project list that includes "Receipt App"
```

`supabase projects list` may also print `Cannot find project ref`; that only
means this checkout is not linked to a project, not that the login failed.

If either check fails, stop and ask the user to log in before continuing:

- Both `vercel login` and `supabase login` open a browser and need an
  interactive terminal. They fail inside an agent shell with a non-TTY error, so
  the user must run them in their own terminal window. The login is saved on the
  machine, so the agent session picks it up afterwards.
- Do not work around a missing login by asking the user to paste an access token
  into the conversation, and do not substitute another credential.

Re-run the checks after the user logs in, and report the result.
