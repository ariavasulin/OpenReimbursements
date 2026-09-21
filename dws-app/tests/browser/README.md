# Isolated Chromium migration checks

From `dws-app`, install Chromium once with `npx playwright install chromium`, then run
`npm run test:browser`. Docker and the Supabase CLI are required. Arguments pass
through to Playwright, for example `npm run test:browser -- --grep compact`.

The existing integration runner creates a fresh PostgreSQL 15/Auth/Storage project,
checks its Docker identity, and replays the schema. Next runs a temporary source
snapshot with no `.env` files or previous build output. Only generated local
Supabase settings enter the child environment. SMS fixture sessions use the real
local Auth API and ordinary application cookies; no test authentication endpoint
or production switch is installed.

`directory-fixture.ts` uses Playwright's
[context initialization script](https://playwright.dev/docs/api/class-browsercontext#browser-context-add-init-script)
to supply deterministic picker handles. Each reopened page gets fresh handles,
permission state, and generated file bytes. The 100,000-entry corpus exposes only
metadata and throws if any code attempts to read its bytes. Original uploads use
real generated PNG bytes, the application hash worker, and isolated Storage.

Recovery closes the actual page after A commits and B has transferred its first
TUS chunk. Fixture SQL then simulates the passage of the two-minute lease period.
This does not claim a wall-clock expiry test or native office-drive picker test;
the latter remains the plan's Phase 7 operator drill.

Generated assertions, exact Storage byte/hash results, request measurements,
screenshots, and traces are ignored under `test-results/`. Open a trace with
`npx playwright show-trace <trace.zip>`. A human or implementer must inspect the
screenshots and write a visual ruling beside the report; passing DOM assertions
alone are not visual verification. Screenshot-only CSS hides the development
query-tools launcher because it overlaps the phone footer; it changes no product
control or test interaction.

## Click through the app yourself: `npm run review:stack`

`scripts/review-stack.mjs` gives a person (or a reviewing model driving a browser) a
local DWS Photos to sign in to, on a throwaway database that already holds realistic
photos. It is for looking and clicking; it asserts nothing. Docker and the Supabase CLI
are required, exactly as for the suites above.

```bash
cd dws-app
npm run review:stack                     # build, then serve on a free port
npm run review:stack -- --dev            # skip the build and run `next dev` instead
npm run review:stack -- --info-file /tmp/review-stack.json
npm run review:stack -- --migrations-through 20260920235021
```

Wait for `REVIEW STACK READY` (a few minutes: containers, migrations, then
`next build`). It prints a JSON object with the `url`, the sign-in `phone` and `code`,
the seeded counts, the Supabase project id, the temporary `workdir`, and its own `pid`;
`--info-file` writes the same JSON to a file once the app is serving, so the file
appearing means "ready". Open the `url`: it sends you to the real login page. Sign in
with phone **+1 555 555 0199** and code **4321**, and you land on the photos home. No
SMS is sent: the number is a local test number added to the generated Supabase config.

Stop it with Ctrl-C, or `kill <pid>` from another terminal. It stops Next, removes its
Supabase containers and volumes, and deletes the workdir and the info file. Nothing is
kept between runs, so every start is the same clean seed.

What it seeds, by direct inserts and Storage uploads (never through the UI):

- Three people: the reviewer you sign in as (employee), one colleague (employee), and
  one administrator. Only the reviewer has a sign-in code.
- Eight projects: two with names over 60 characters, one hand-made project with a
  generated `P-` code, and four with no photos at all.
- The photos in `--seed-dir` (default `<repo>/.artifacts/photo-albums/review-seed`,
  dated by its `manifest.tsv`), each with an original, a thumbnail, and a preview,
  spread over four projects, uploaded alternately by the two employees, about a third
  of them tagged, and one in the trash. If the directory is missing it says so loudly
  and seeds generated placeholder images instead.
- Once the database has them: about six photos with no project, and the albums
  "Christmas Party 2015", "Marketing", "Smith Residence – Finished", and an empty one.
  The script reads `information_schema` to see what exists, so the same command works
  before and after the albums migration.

`--migrations-through <14-digit timestamp>` applies only migration files up to that
timestamp (baseline files always). Use it while a newer migration in
`supabase/migrations/` is still being written and may not apply yet.

Safety is the integration runner's, reproduced: a generated `dws-test-<hex>` project on
loopback ports, the local-target assertion, the Docker identity check, and the
PostgreSQL 15 check all run before the first change. There is no option that points it
at a linked or remote project, and it never reads `.env.local` — Next runs from a
source snapshot in the workdir with an allowlisted environment. Because it is a
snapshot, edits you make while it is running do not show up; restart it to pick them up.

`next start` marks the session cookie `Secure`. Chrome and Firefox accept that on
`http://localhost`; Safari does not, so use `--dev` if you want to sign in with Safari.
