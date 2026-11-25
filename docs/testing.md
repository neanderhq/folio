# Verification

Run `pnpm verify` after [development setup](development.md). This preserves the
existing app tests and build, and adds the common repository policy check.
TypeScript is the existing static gate; this migration does not introduce a new lint ruleset.

## CI gates

- **policy** checks repository identity/files, runtime pins, immutable action pins,
  read-only permissions and the production verification entry point.
- **app** runs the source checks and existing app-specific assertions.
- **Runtime security** (the `production` job) builds the real Docker image,
  scans it with checksum-verified Trivy, initializes a disposable PostgreSQL
  service and runs `pnpm test:production`. The alias preserves `test:template`.
- **Dependency audit**, **Dependency review** and GitHub CodeQL remain required.
  Runtime and dependency scans also run daily. Existing additional deployment
  checks remain in their separate workflow where present.

## Production smoke coverage

Production HTTP/static assets, private signup/workspaces, CRM behavior and isolation, seed retries, preserved edits/deletions and container replacement.

The optional `NEANDER_TEMPLATE_BROWSER_TESTS=1` pass requires Chromium installed
with `pnpm exec playwright install --with-deps chromium`. It runs the rendered
record editor regression against the same built container: repeated refresh keeps one
set of controls, opening an editor uses current values, cancelled drafts stay
cancelled, stale saves preserve the draft and expose latest saved values for an
explicit retry, and keyboard tabs/stage changes and phone validation persist.
It also checks long account identities inside the sidebar at 1440px and 1024px,
and forward/reverse Tab containment in workspace search and nested record editors.
The browser uses a fresh profile and fictional records in the explicit disposable
database; it never uses an authenticated personal browser profile.

For local production verification, set that flag and run `pnpm test:production`
with the usual image/database/origin variables below. An installed Chrome can be
selected with `PLAYWRIGHT_CHANNEL=chrome`. Optional
`NEANDER_TEMPLATE_UI_EVIDENCE=/absolute/ignored/path` saves fictional screenshots
and a JSON result. Private template callers without the flag retain the existing
API/HTTP verification path; this focused browser suite does not claim complete UI
or reference-product parity.

CI supplies only fictional credentials and an isolated local PostgreSQL service.
`DATABASE_URL` and `NEANDER_TEMPLATE_TEST_DATABASE_URL` must identify the same
explicitly disposable database. Build the image and apply the existing recipe's
migration/seed commands before invoking the smoke suite. `.github/workflows/check.yml`
is the executable setup reference; test credentials there are CI fixtures.
The suite starts/stops its own local app container and writes synthetic records.
Never copy these commands onto an existing customer database.

Passing this CI establishes the assertions in the existing suites, not complete
product acceptance, physical-device/mobile coverage, managed Neon/Cloud Run
deployment, real email delivery or the desktop Neander Publish path. Keep the
README's product-specific limitations. Add regression tests for behavior changes;
do not replace real app checks with boilerplate-only assertions.

## Follow-up rules

`DATABASE_URL=<disposable PostgreSQL URL> pnpm exec tsx scripts/check-followups.ts` exercises persisted rules/tasks/history, role and tenant boundaries, replay/re-entry, notices, timezone dates, conflicts, downgraded assignees, a real PostgreSQL task-insert failure with atomic rollback, correction/retry and disabling. The production verifier invokes it with sample initialization disabled. It installs/removes a uniquely named fault trigger only in the explicitly disposable database.
