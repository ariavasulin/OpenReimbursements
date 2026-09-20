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
