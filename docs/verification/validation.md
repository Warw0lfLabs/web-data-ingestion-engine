# Final validation

**CI evidence correction (13 October 2026):** GitHub success conclusions are not proof of successful tests. Run `38440125182` was confirmed false-green with eight failed tests. See the CI investigation below; earlier publication/status statements are historical reports of GitHub conclusions.

This is the final-validation stage report. Later documentation finalization reorganized README, architecture, and source policy without changing application code/configuration or the recorded results below.

Status: **PASSED**, 2026-10-06. This validates V1 after implementation, manual testing, and security review. GitHub-hosted CI and production deployment were not exercised.

Later owner-reported smoke testing identified an unresolved whole-stack Compose restart limitation. The historical results below remain unchanged; see the addendum for the reported failure and successful recovery.

## Environment and isolation

macOS ARM64 with Colima; host Node.js 22.23.2, Docker 29.5.2, Compose 5.5.1, OpenSSL 3.6.4. Application containers use Node.js 24; PostgreSQL reported 17.11. Chromium was installed through the locked Playwright dependency.

A temporary source copy was created from Git's tracked/unignored file list, excluding `.env`, dependencies, build output, and Git metadata. `npm ci`, `cp .env.example .env`, and `npx playwright install chromium` succeeded there. This was a fresh-source-copy simulation, not a fresh Git clone: the project files are currently untracked. After fixes, executable/configuration/test files in the copy were compared against the working repository and matched.

Compose project `ingestion-final-validation` used a newly created application volume. Automated integration tests used a separate newly created PostgreSQL container, `ingestion-final-validation-tests`, database `ingestion_test`, exposed only at localhost:5544. Neither reused earlier-stage database state.

## Automated checks

The following all passed in both the clean copy and the working repository after fixes:

| Command                                                                                                   | Actual result                                                          |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `npm run format:check`                                                                                    | Passed                                                                 |
| `npm run lint`                                                                                            | Passed                                                                 |
| `npm run typecheck`                                                                                       | Passed, strict TypeScript                                              |
| `npm run build`                                                                                           | Passed                                                                 |
| `npm test`                                                                                                | 33 tests, 4 files passed                                               |
| `TEST_DATABASE_URL=postgresql://ingestion:testing@localhost:5544/ingestion_test npm run test:integration` | 22 tests, 1 file passed; real PostgreSQL/API and ingestion integration |
| `npm run test:browser`                                                                                    | 10 tests, 1 file passed; actual Chromium                               |

Total: **65 tests passed, zero failed**. The earlier security report's 64 is its historical total; this stage added one test.

Also executed successfully: `docker compose config --quiet`, `docker compose build`, and clean Compose startup with image builds. Clean host database migration used `DATABASE_URL=postgresql://ingestion:testing@localhost:5544/ingestion_test npm run db:migrate`; integration tests subsequently checked migrations again.

## Clean startup and database

After the bootstrap portability fix below, `docker compose -p ingestion-final-validation up --build -d --wait` succeeded without manual SQL intervention. PostgreSQL, API, worker, fixture server, and browser service became healthy; the migration service exited zero. Only the API was host-published, at localhost:3000. PostgreSQL and browser ports remained internal.

To inspect the queued lifecycle independently, a subsequent new-volume startup initially selected `postgres migrate api fixture-server browser`, leaving the worker stopped. API readiness and source listing worked; the authenticated trigger queued successfully after the API initialization fix. The worker was then started and consumed the actual queued job.

Database inspection confirmed application migration `001_initial` and 20 Graphile migrations, maximum version 20. Runtime role inspection confirmed `rolsuper=false` and `rolbypassrls=false`. API and worker operated against that schema and role. An initial PostgreSQL log error for missing `graphile_worker.migrations` was Graphile's initial schema probe; setup then created the schema and completed successfully. It was not a failed migration.

Local integration execution still emits pg's warning about queuing queries on a busy client, with removal planned in pg 9. It did not cause a failure with the installed pg 8 dependency: run-detail reads, retries, persistence, and all integration tests passed. No corresponding warning was found in captured Compose logs. Future pg 9 compatibility is not established by this validation.

## Real HTTP end-to-end evidence

Requests used the actual localhost API, bearer authorization, bounded polling, and running Graphile worker. Fixture content changes used the existing in-process fixture helper through a disposable Compose command override, recreating only the fixture server. No catalog rows or retry due times were manually modified. Every run below finished `succeeded`; each accepted one listing and rejected zero.

| Scenario                 | Expected                                 | Actual evidence                                                                                                                                               |
| ------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Health and documentation | Live/ready and Swagger available         | Both health endpoints HTTP 200; `/docs` and `/docs/json` HTTP 200; ten OpenAPI operations, trigger 202 and bearer security documented                         |
| Sources                  | Three trusted configurations             | `/v1/sources` returned three; structured source detail HTTP 200                                                                                               |
| Initial JSON-LD          | Queue, then ingest initial offer         | Run `dcaac3f8-6414-4254-861a-7ac35c30f930`; queued at attempt zero before worker startup, then succeeded at attempt one; extractor `jsonld`, changed=1        |
| Unchanged rerun          | No duplicate history                     | Run `9e1be672-9a32-4306-aaab-119d3b9b1634`; changed=0; history remained one identical entry, `last_changed_at` unchanged                                      |
| Price change             | Update current offer and append history  | Run `a9899864-9eea-42da-ba1b-f46ba2066e21`; changed=1; 19.99 → 17 USD, history grew to two with original intact                                               |
| Availability change      | Update current offer and append history  | Run `199d3264-dd8f-467b-bc6c-a6b76d5f3abb`; changed=1; in stock → out of stock, history grew to three with both earlier entries intact                        |
| Static DOM               | CSS extraction succeeds                  | Run `b6c21642-b349-4dff-a3ac-d410242c5bc9`; extractor `dom`, changed=1; current offer 29.50 USD/in stock                                                      |
| JavaScript fixture       | Actual browser fallback succeeds         | Run `41ea7abf-e207-491e-9312-8d618351b985`; observed queued → running → succeeded; extractor `browser`, changed=1; 49 USD/in stock                            |
| Transient failure        | Persist retry and execute later          | Run `d27fd69a-748c-49a8-b335-04b1dab67915`; observed queued → retrying → succeeded, two attempts, first `HTTP_503`; changed=0, structured history still three |
| Authorization            | Missing/invalid rejected; valid accepted | Both rejected with HTTP 401; authorized manual triggers returned HTTP 202                                                                                     |
| Pagination               | Traverse without duplicates              | `limit=1`: products 3 records/3 pages, runs 9/9, structured history 3/3; unique IDs and terminal null cursor                                                  |

Two scheduled catch-up runs account for the nine runs at pagination inspection. Short successful HTTP-only jobs sometimes completed between polls; their intermediate running state was not claimed as observed. The browser job's running state and retry job's retrying state were observed directly.

Products, product details, variants, and current offers were inspected through the API. Structured variant `46507e49-3ebe-44cc-a236-4d1e55246c37` had the following API history, cross-checked through PostgreSQL joins:

| History ID | Price     | Currency | Availability |
| ---------- | --------- | -------- | ------------ |
| 1          | 19.990000 | USD      | in_stock     |
| 2          | 17.000000 | USD      | in_stock     |
| 3          | 17.000000 | USD      | out_of_stock |

Retry attempt one ended at `2026-10-06T13:05:58.210Z`, with due time `13:06:02.277Z`. Attempt two actually began at `13:06:04.116Z`, after that due time, and succeeded at `13:06:04.131Z`. Prior history stayed intact.

The README's token-safe Node trigger example was separately executed; it returned 202, run `3fc1e0f7-8da0-4f1b-81b0-ed88afd37daf`, subsequently inspected as succeeded with one attempt. Actual `docker compose stop` and `docker compose start --wait` succeeded; readiness returned 200 and the three structured history entries remained available after restart. Captured container logs were inspected; final operation showed no unexpected crash or unhandled exception. The intentionally generated 503/retry and initial Graphile schema probe were accounted for.

## Defects and fixes

1. **Clean-copy PostgreSQL bootstrap failed.** Colima did not share the temporary checkout directory; the bootstrap SQL bind source became a directory, and PostgreSQL reported `Is a directory`. Added `docker/postgres.Dockerfile` to package SQL into the PostgreSQL image and changed Compose to build it. Removed the failed disposable volume and repeated clean startup successfully. Verified through actual image build and fresh-volume startup; no synthetic unit test added for Docker host mounting.
2. **OpenAPI reported trigger response 200 instead of 202.** Added explicit 202 response and structured error response schemas. Expanded the existing API integration test to assert 202/401/409 documentation and absence of the incorrect 200 response; actual `/docs/json` was checked again.
3. **API trigger before worker startup returned 500.** Only worker startup populated the source registry, so a ready API could encounter the run's source foreign-key violation. API startup now initializes the same trusted registry before accepting requests. Added integration regression `initializes configured sources and queues a run before any worker starts`, checking readiness, queued attempt-zero run, empty attempts, source rows, and durable Graphile job. Repeated the real clean startup without worker and verified queued → completed after worker startup.

The complete automated suite was rerun after these changes. No new features or architecture redesign were introduced.

## Documentation and new developer experience

Reviewed README, architecture, source policy, prior stage reports, `.env.example`, and generated API documentation against current behavior. Corrected README with executable health/source/manual-trigger walkthrough, result inspection and terminal-state guidance, Swagger URLs, disposable host test database commands, stop/restart/cleanup instructions, packaged bootstrap behavior, optional Linux browser dependencies, and the distinction between host `.env` settings and Compose's supplied database/network configuration. Clarified scheduled catch-up behavior and configuration variables.

Architecture corrections describe registry initialization in both entry points, actual processing/SQL bounds, current network isolation, and runtime database-role bootstrap. Historical manual/security reports now point to this report for current validation without replacing their historical test totals. Source policy and `.env.example` were reviewed and needed no further edit in this stage.

Fresh-copy dependency installation, configuration setup, Chromium installation, Docker builds/startup, health checks, Swagger, manual trigger, inspection, all tests, stop/restart, and cleanup were exercised. A separate operator helper automated HTTP polling and fixture changes; it did not replace missing README setup instructions. Host-only long-lived entry points and the documented upgrade of an archived pre-security database volume were not independently exercised here.

## GitHub Actions static review

Workflow YAML and referenced package scripts were checked locally. Node 24 satisfies the supported engine range. PostgreSQL 17, test database name and credentials match integration requirements; CI uses port 5432 instead of local 5544. Playwright installs Chromium with system dependencies. Formatting, lint, types, unit/integration/browser tests, build, Compose config, and image builds are present. The new PostgreSQL image is included by Compose build. Permissions are `contents: read`; all three action references use full 40-character commit pins. Failure logs have seven-day artifact retention. There is no deployment step.

**GitHub-hosted CI was not run and is not marked passed.** Static review and successful local equivalent checks are the available evidence.

## Files and cleanup

Changed this stage: `compose.yaml`, new `docker/postgres.Dockerfile`, `src/modules/api/app.ts`, `tests/integration/engine.test.ts`, `README.md`, `docs/architecture.md`, historical notices in `docs/manual-testing.md` and `docs/security-review.md`, and this new report.

Git status showed the project files untracked, so a tracked diff cannot represent this stage's changes. No files were staged or committed. Existing `.env`, `node_modules`, and `dist` are ignored local configuration/dependency/build outputs and were retained. Disposable scripts, override configuration, logs, evidence JSON, and source copy were outside the repository and removed after recording evidence. The validation Compose containers/networks/application volume and standalone test container/anonymous database volume were removed. Earlier-stage stopped containers and unrelated application data were left untouched. Built image/cache layers may remain in Docker; no global prune was performed.

## Remaining limitations

- Whole-stack `docker compose restart` can restart the one-shot migration service into a transient DNS failure. Recovery with `docker compose up -d --wait` succeeded in the owner's smoke test, but the underlying behavior has not been fixed.
- No remote GitHub CI evidence or actual fresh Git clone; all project files remain untracked.
- Future pg 9 compatibility warning remains; installed pg 8 operation passed.
- Historical-volume upgrade and host-only deployment path were reviewed rather than independently recreated.
- This stage does not establish production TLS, image-CVE assessment, full IPv6 coverage, or support for arbitrary public browser workloads. Existing source-policy/V1 restrictions remain.

Final validation passed for the tested V1 scope, subject to the limitations above.

## Owner-reported restart limitation and recovery

Reported on 13 October 2026 during the final manual smoke test: `docker compose restart` restarted all containers, including `migrate`, which exited with code 1 and `Error: getaddrinfo EAI_AGAIN postgres`. The error indicates transient resolution failure for the PostgreSQL service name during restart; its precise cause has not been established. All long-running services eventually became healthy, but the migration run had failed.

The owner verified persistence: all three products retained their original UUIDs, product timestamps remained consistent, and price history stayed intact without duplicate records. A subsequent `docker compose up -d --wait` completed successfully, with `migrate` exiting 0 and all long-running services remaining healthy.

This is a documented recovery result, **not a permanent fix**. The one-shot migration service and existing startup dependency design are unchanged. Normal startup/recovery should use the README's `up` commands, checking migration exit status separately from long-running service health. The earlier successful `stop` / `start --wait` validation did not exercise whole-stack `restart`.

These observations come from the owner, not a new execution during this documentation update. No automated tests or runtime scenarios were rerun, and the historical total of 65 passing tests is not additional evidence for restart safety. See the [manual-testing addendum](manual-testing.md#owner-reported-final-smoke-test-whole-stack-restart) for the reported sequence and evidence limits.

## Publication and GitHub CI addendum — 13 October 2026

The owner supplied the following verified publication facts:

- Public repository: [Warw0lfLabs/web-data-ingestion-engine](https://github.com/Warw0lfLabs/web-data-ingestion-engine).
- Initial commit: `9695309f0c61424dbf7957e791c78623ded0aed1`; GitHub verified its signature (`verified: true`, `reason: valid`).
- GitHub Actions workflow **Development checks**, run [38427214001](https://github.com/Warw0lfLabs/web-data-ingestion-engine/actions/runs/38427214001), concluded **success**.
- Local `main` was synchronized with `origin/main`, and the working tree was clean before the current documentation edits.

The October 6 statements about untracked files and the absence of GitHub-hosted CI execution describe the historical validation environment. They are preserved as evidence of that run; the project was subsequently published and GitHub-hosted CI passed as recorded above.

This addendum records the owner's verified facts, not a new CI execution or additional runtime validation performed during this documentation update. It does not establish production readiness. The Docker Compose whole-stack restart limitation documented above remains unresolved; successful recovery and CI do not constitute a fix for that behavior.

## Supported lifecycle implementation validation — 13 October 2026

Implemented `scripts/stack-restart.sh` as an operator alternative to native whole-stack restart. It resolves the project directory, checks prerequisites/configuration, stops the stack, uses `up -d --wait`, and independently inspects JSON container states. It requires the migrator to be exited with code 0 and every configured long-running service to be running/healthy. Nonzero Compose results remain failures even if later state checks succeed. It performs no volume removal, database reset, fixed readiness sleep, image-rebuild request, or automatic migration-sequence retry.

Added 23 mocked regression tests covering successful ordering/state checks, outside-directory invocation (including spaces), additional configured services, migration exit 1/running/missing, unhealthy/stopped/missing/unexpected services, missing health data, multiple containers, malformed inspection JSON, unavailable Docker/Compose/Node/daemon, invalid/unsupported configuration, stop/up/inspection failures, safe diagnostics, and absence of destructive/native-restart commands. Ordinary unit tests do not invoke the real Docker daemon.

Checks executed after implementation:

| Check                                                                  | Result                                                                                                                 |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| New script regressions                                                 | 23 passed                                                                                                              |
| Complete `npm test`                                                    | 56 passed, 5 files                                                                                                     |
| Formatting, lint, strict type checking, TypeScript build               | Passed                                                                                                                 |
| `bash -n scripts/stack-restart.sh`                                     | Passed                                                                                                                 |
| ShellCheck                                                             | Skipped: not installed; no dependency added                                                                            |
| Compose configuration and fresh isolated image build/start             | Passed                                                                                                                 |
| Real isolated workflow, failure injection, readiness gate, persistence | Passed; evidence in [manual-testing addendum](manual-testing.md#supported-lifecycle-workflow-testing--13-october-2026) |
| `git diff --check` and change-scope review                             | Passed                                                                                                                 |

The suite now contains 88 cases (56 unit, 22 PostgreSQL/API integration, 10 browser). The application integration/browser suites were not rerun for this operator-only change; their earlier results remain historical evidence. Actual Docker validation separately exercised PostgreSQL, migrations, HTTP APIs, all three extractors, repeated lifecycle execution, and data persistence. The initial temporary-path assertion and stale HTTP probe-connection failures were corrected in the test harness and rerun successfully; neither required application changes.

Failure handling was reviewed for partial startup: the script returns 1 and identifies the failed phase/service without printing resolved configuration, raw command errors, SQL, or environment values. It does not attempt rollback or automatic retries. Operators must inspect the same Compose project's state/logs and correct the cause. V1 requires one container per service, no profiles, the existing `migrate` role, and health checks for other services. The script trusts operator-controlled Compose/environment settings and deliberately stops the selected project; selecting the correct project remains the operator's responsibility. Schema upgrades still require stopping application processes and rebuilding updated images separately.

Only the operator script, its unit tests, README, and these two reports changed. Application code, Compose configuration, Dockerfiles, migration implementation, security controls, dependencies, and CI definition were unchanged. Existing CI's unit command will include the new tests; no new GitHub-hosted run is claimed. Disposable resources were cleaned up without touching existing application data. No commit or push was performed.

**Supported lifecycle workflow: PASSED for the tested V1 environment.** This addresses the operational lifecycle mismatch with an ordered, checked workflow. Docker's native whole-stack restart remains unsupported; its DNS timing failure remains undiagnosed. The historical validation/publication statements and limitations above remain intact.

## Alternate-target safety hardening — 13 October 2026

Independent review identified that inherited Compose selectors could stop a different project without explicit acknowledgment. The script now pins its default to project `web-data-ingestion-engine` and the repository's `compose.yaml`. It prints only the effective project identity and canonical file selection before stopping services. Alternate projects/files require the exact environment opt-in `INGESTION_STACK_ALLOW_ALTERNATE_TARGET=1`; the selection is pinned with CLI flags and the resolved project identity must match. Invalid names, relative/missing/duplicate files, unsupported Compose environment controls, and Compose settings in `.env` fail before mutation. Automatic override-file discovery is disabled.

The acknowledgment is non-interactive and permits automation/disposable projects, but does not certify isolation, trusted file contents, or the chosen Docker context. It should be scoped to one invocation rather than exported globally. Default invocation needs no opt-in.

The script test harness explicitly sanitizes inherited Compose variables and acknowledgment. Seventeen additional cases cover alternate project/file refusal and opt-in, explicit default selectors, invalid/ambiguous selections, implicit `.env` targets, inherited environment contamination, and resolved identity mismatch. All **73 unit tests passed**, including **40 script regressions**. Formatting, lint, type checking, build, shell syntax, and `git diff --check` passed. Initial argument assertions were corrected for pinned CLI flags; local fixture tests required permitted server binding before the successful full rerun.

The suite now contains 105 cases (73 unit, 22 application integration, 10 browser); application integration/browser suites were not rerun. No real Docker lifecycle commands were executed for this hardening, and the owner's application stack was not touched. Earlier disposable runtime results above predate the guard and remain historical evidence. Migration implementation, application code, and Compose architecture were unchanged. Native restart behavior remains unsupported and unfixed.

## Dependency-gate preflight correction — 13 October 2026

Preflight now validates the five mandatory startup dependencies in the resolved Compose JSON before `stop`: healthy PostgreSQL before migration; successful migration before API/worker startup; healthy fixture server and browser before worker startup. Each edge must use its exact V1 condition and be mandatory (`required: true` or omitted, which defaults to true). Missing services/maps/edges, short-form dependencies, malformed edges, weaker/invalid conditions, and optional dependencies fail before mutation, even with alternate-target acknowledgment. Existing target-selection safeguards and independent container-state checks remain in place.

Added 46 mocked regression cases: one valid resolved alternate configuration with explicit mandatory dependencies, and nine invalid configurations for each of the five gates. Rejection cases assert that neither `stop` nor `up` executes. The complete unit suite passed: **119 tests in 5 files**, including **86 operator-script cases**. Formatting, lint, strict type checking, build, shell syntax, and `git diff --check` passed. The suite contains 151 tests overall; the 22 application integration and 10 browser tests were not rerun for this operator-only correction.

No real Docker lifecycle commands were executed for this correction. Runtime behavior of the updated preflight has only mocked regression evidence; earlier disposable Compose results remain historical. Application/migration code and Compose architecture were unchanged. Native whole-stack restart remains unsupported and unfixed; acknowledgment still does not certify trusted contents or Docker-context isolation. No commit, push, or deployment was performed.

## Final guarded lifecycle real-Docker validation — 13 October 2026

The final operator script was executed against uniquely named disposable project `ingestion-lifecycle-final-20261013-c77d12`, isolated localhost port 55230 and its own PostgreSQL volume. Real resolved Compose JSON confirmed all five mandatory startup gates and `required: true`. Fresh startup, two supported script restarts, deliberately weakened gate rejection, missing-acknowledgment rejection, migration exit-23 failure detection, and recovery all produced the expected results. Complete compared offer-history rows and product/variant identities/current offers persisted across both restarts and recovery, without duplicates. Owner lifecycle/data snapshots were unchanged and readiness remained healthy.

**Real-Docker lifecycle validation: PASSED for the tested final script/environment.** Exact commands, run/product/variant IDs, snapshot hash, isolation checks, and cleanup evidence are recorded in the [manual-testing addendum](manual-testing.md#final-guarded-lifecycle-runtime-validation--13-october-2026). Three temporary-probe mistakes (column names, migration-table name, undefined-field JSON comparison) were reported and corrected; no application defect or implementation change resulted. Immutable existing local images were reused, not rebuilt. All original Docker resource identities/counts remained after removal of disposable resources only.

This supersedes the earlier statement that the final guards had only mocked evidence for these tested scenarios. It does not imply production readiness, a new hosted CI run, or a fix for native whole-stack restart. The native restart/DNS timing limitation remains unsupported and unfixed. Timing gates were verified from real resolved configuration; this run did not independently delay each prerequisite or simulate interruption at every lifecycle phase. Historical application integration/browser results remain historical.

Post-documentation checks: complete `npm test` passed **119 tests in 5 files** (including 86 script regressions); formatting, lint, typecheck, build, `bash -n scripts/stack-restart.sh`, and `git diff --check` passed. The initial formatting check flagged the new Markdown tables; formatting only these reports corrected it before the successful rerun. No application integration/browser suite or hosted CI run was performed in this task. Only `docs/manual-testing.md` and `docs/validation.md` were edited during this validation; earlier pending README/script/test changes were preserved. No commit, push, deployment, or owner-stack restart was performed.

## Owner smoke evidence and repository reconciliation — 13 October 2026

The owner supplied a successful original-stack `scripts/stack-restart.sh` run (exit 0), five healthy long-running services, migrator exit 0, readiness HTTP 200, nine PostgreSQL tables, and post-restart counts of products=3, variants=3, offer_current=3, offer_history=3, ingestion_runs=6. This is owner-performed smoke evidence, separate from the isolated execution and baseline comparisons documented above. Without a pre-restart baseline, it does not establish exact owner-data preservation. Native whole-stack restart remains unsupported and unfixed.

Reconciled README's current hosted-CI statements with the owner-verified October 13 publication addendum while retaining all historical October 6 reports. The hosted run predates the pending operator changes; no new hosted result is claimed. Replaced a workstation-specific repository path in the lifecycle command transcript with a portable current-directory expression. Temporary paths in the reports are deliberate historical evidence outside the repository, not files shipped with the project.

Repository hygiene review covered all 59 tracked/intent-to-add files, untracked/ignored inventory, credential/prompt/path patterns, and the full pending diff. No unintended staged files were present (cached diff empty). The only pending paths were the intended README, two stage reports, executable operator script, and its unit tests. No untracked publishable files or tracked generated artifacts were found. `.env`, `node_modules/`, and `dist/` remain ignored local files; they were not removed or published. Credential-pattern checks found no suspected non-example secrets; existing demonstration database/token values are documented examples. No accidental AI/tool/prompt artifacts or personal absolute paths remained. Historical `/tmp` evidence paths and system executable paths in tests are intentional. This bounded hygiene check is not a new security audit or proof that every possible secret format is absent.

Reconciliation checks actually executed:

| Check                                                                                                     | Actual result                                              |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `npm test`                                                                                                | 119 passed, 5 files, including 86 operator regressions     |
| `npm run test:browser`                                                                                    | 10 passed, 1 file, installed host Chromium/local fixtures  |
| `TEST_DATABASE_URL=postgresql://ingestion:testing@localhost:5544/ingestion_test npm run test:integration` | 1 suite failed during setup; 22 tests skipped, none passed |
| Formatting, lint, typecheck, build                                                                        | Passed                                                     |
| `bash -n scripts/stack-restart.sh`                                                                        | Passed                                                     |
| `git diff --check` and `git diff --cached --check`                                                        | Passed; staged diff empty                                  |

Current total: **129 tests passed; 22 skipped; one failed integration suite**. The documented disposable PostgreSQL endpoint refused connections on both IPv4 and IPv6 at port 5544. Integration teardown also raised `TypeError` at `tests/integration/engine.test.ts:43`, because `fixture` was undefined after setup failed. No application assertion ran in that suite, and historical integration passes are not evidence of a current rerun. No Docker lifecycle command was executed to supply the missing database, honoring this task's constraint; the owner database was not used. The teardown guard remains a test-harness issue for a separately authorized correction.

**Recommendation: CHANGES REQUESTED for final sign-off.** Documentation and file hygiene review passed within the stated scope, but a working dedicated disposable test database and successful rerun of all 22 integration cases are still required; address the setup-failure teardown guard in an authorized test change. No application/migration/Compose changes, commit, push, deployment, or Docker lifecycle operation were made during this reconciliation. Only README and the two validation reports were edited; prior script/test changes were preserved.

## Integration validation blocker resolution — 13 October 2026

The prior failure was environmental: the documented host test endpoint at localhost:5544 had no PostgreSQL service. `npm run test:integration` requires `TEST_DATABASE_URL` naming a dedicated `*_test` database; it does not start PostgreSQL itself. The documented manual setup uses PostgreSQL `17-bookworm`, user `ingestion`, example password `testing`, database `ingestion_test`, loopback host port 5544 to container port 5432, and a fresh anonymous data volume. The suite applies migrations and clears only that disposable test database between cases.

Before provisioning, existing Docker container/network/volume identities and published ports were inventoried, the exact `ingestion-tests` name was absent, and a localhost:5544 socket-bind probe succeeded. No existing application or test container was started/reused. Commands executed after isolation was established:

```sh
docker run -d --name ingestion-tests -e POSTGRES_USER=ingestion -e POSTGRES_PASSWORD=testing -e POSTGRES_DB=ingestion_test -p 127.0.0.1:5544:5432 postgres:17-bookworm
docker exec ingestion-tests pg_isready -U ingestion -d ingestion_test
docker inspect --format '{{json .Mounts}}' ingestion-tests
docker port ingestion-tests
TEST_DATABASE_URL=postgresql://ingestion:testing@localhost:5544/ingestion_test npm run test:integration
npm test
npm run test:browser
npm run format:check
npm run lint
npm run typecheck
npm run build
bash -n scripts/stack-restart.sh
git diff --check
docker rm -f -v ingestion-tests
```

Readiness reported accepting connections; published binding was only `127.0.0.1:5544`. Container ID was `445696c22385a4e75472158cb77eecb1ea6f2a6e1ea1997915ac8c958a1f3e24`, and the newly created anonymous volume was `8b83842dd09f8194c862d19e42684741a65c8778e1b6bb291f11ab26dc61ce7e`. Cleanup removed only that container and its volume. Final inventory comparisons restored every original identity: 32 containers, 14 volumes, 11 networks. The owner API remained healthy with unchanged start/finish timestamps, and readiness returned `{"status":"ready"}`. No owner lifecycle command was executed.

The separate teardown defect was an unconditional `fixture.server` access after setup failed before assigning `fixture`. The minimal integration-test change checks fixture existence and closes the pool in `finally`. New unit regression `tests/unit/integration-cleanup.test.ts` launches the actual integration hooks in a child process with unreachable destination port zero; it asserts the original setup failure, nonzero exit, and absence of a secondary TypeError. That child suite's deliberate failed setup/skipped cases are regression input, not an integration-validation pass or additional counted tests.

The initial new regression assertion expected only `ECONNREFUSED`; this macOS host reported `EADDRNOTAVAIL` for port zero. The assertion was corrected to accept these two connection-error codes, and the targeted regression rerun passed. This initial failed assertion is retained as evidence rather than hidden. No application behavior changed. The real database integration run passed **all 22 tests**, zero skipped; the browser suite passed **all 10 tests**. Integration output still includes the previously documented pg busy-client deprecation warning; future pg 9 compatibility remains unverified. Native whole-stack restart remains unsupported and unfixed.

Final rerun: **120 unit tests passed in 6 files**, including the setup-failure regression; **22 integration tests passed in 1 file**; **10 browser tests passed in 1 file**. Total: **152 passed, zero failed, zero skipped** in the actual validation suites. Formatting, lint, strict typecheck, build, Bash syntax, and staged/unstaged diff checks passed after the test correction and documentation updates. The first unit run had 119 passed/1 failed due to the newly added error-code assertion described above; the successful complete rerun supersedes that attempt. README now records 152 cases.

**Recommendation: PASS for resolution of this integration-validation blocker.** This supersedes the prior reconciliation's CHANGES REQUESTED recommendation for missing database/unsafe teardown. Changed during this task only: `tests/integration/engine.test.ts`, new `tests/unit/integration-cleanup.test.ts`, README's suite count, and this report. Earlier pending lifecycle/manual-test documentation changes were preserved. No application, migration, production database, Compose architecture, Dockerfile, or dependency change; no owner-stack lifecycle operation, commit, push, or deployment. Existing native-restart, pg deprecation, and lack of hosted CI for pending changes remain documented limitations.

## False-green CI investigation — 13 October 2026

Downloaded the actual log with `gh run view 38440125182 --repo Warw0lfLabs/web-data-ingestion-engine --log`, retained outside the repository. [Run 38440125182](https://github.com/Warw0lfLabs/web-data-ingestion-engine/actions/runs/38440125182) for commit `243e0dbcb964cd89d8ddbb14660011fe639dbb88` reported success despite **120 unit passed, 21 integration passed/1 failed, 3 browser passed/7 failed**: 144 passed, eight failed. This explicitly corrects any interpretation of green hosted status as complete test success. The older publication addendum records a GitHub conclusion only; its underlying tests were not re-audited here.

Confirmed workflow cause: the log shows `/usr/bin/bash -e {0}` for all three test pipelines. Without pipefail, `npm ... | tee ...` returns tee's successful status and does not fail the step. Consequently failure-only artifact upload did not run. Changed every test pipeline to begin with `set -o pipefail` and set the job's run shell explicitly to Bash. Logs and failure-conditioned artifact upload are preserved; no continue-on-error, retry, or assertion change was added. [GitHub shell documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idstepsshell) distinguishes implicit shell behavior from explicit Bash's pipefail behavior.

Six new unit cases parse the real workflow bodies and execute each with a temporary fake npm command returning 0 or 23, under `bash -e` without implicit pipefail. All three failing commands must propagate exit 23, and each log must retain the probe output; all three successful commands must return 0. This validates failure propagation locally without intentionally failing or executing the production workflow. Temporary probe directories are cleaned up.

### Hosted browser/integration analysis

The actual runner was Ubuntu 24.04.5, image `ubuntu-24.04` version `20261004.327.1`, Node.js 24 versus local macOS Node.js 22.23.2. The direct Playwright `launchServer` test reports Chromium's fatal **No usable sandbox** message. This is confirmed sandbox launch failure for that test, not exhaustion of extraction time. Other browser exceptions pass through `BrowserExtractor`'s generic catch and become retryable `BROWSER_TIMEOUT`, hiding their original cause. Seven browser cases failed within a roughly three-second suite, despite normal 30-second source budgets. Network/WebSocket assertions did not prove policy violations were handled: they received the launch error classification instead. Three passing cases (forbidden source, expected timeout, generic byte-error rejection) do not establish browser startup.

The integration failure is the JavaScript/browser pipeline case at line 219: the ingestion attempt logged retryable `BROWSER_TIMEOUT`, persisted retrying/accepted=0, and the test expected succeeded/accepted=1. The retry state is consistent with the runner's error handling; it is not evidence of a persistence/queue defect. The shared sandbox environment is the strongest explanation, but the integration log masks the raw launch exception, so that exact cause is inferred rather than separately proven for this attempt.

Reviewed deadline/queue/resource serialization, context/browser close paths, fixture readiness, and test assumptions. Normal tests have 30-second source budgets; explicit timeout/queue tests use smaller budgets intentionally. CI runs the suites sequentially. The fast fatal launch plus direct sandbox diagnostic supplies no evidence that resource contention, arbitrary sleeps, asynchronous teardown, or a longer timeout would fix this run. The independent setup-failure cleanup regression remains in place. No production exception mapping, timeout, cleanup, security policy, or assertion was changed in this task.

Ubuntu's AppArmor unprivileged-user-namespace restrictions are a plausible underlying sandbox incompatibility; the kernel/AppArmor policy was not logged, so that specific mechanism remains unconfirmed. [Chromium's documentation](https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md) describes executable-scoped AppArmor allowances and sandbox-helper alternatives. Recommended next verification: capture the actual runner policy and installed Chromium executable paths, test a sandboxed direct launch, then validate a narrowly scoped runner-only profile for those exact executables (including headless shell) or a suitable sandbox-enabled isolated test environment. Do not globally disable AppArmor/user-namespace restrictions, use `--no-sandbox`, or grant privileged containers merely to turn tests green. Such an environment change was not implemented because it cannot be demonstrated on this macOS host without an equivalent Linux runner.

### Local validation and isolation

Inventory and localhost:5544 bind/name checks passed before provisioning. Used only the documented new `ingestion-tests` database:

```sh
docker run -d --name ingestion-tests -e POSTGRES_USER=ingestion -e POSTGRES_PASSWORD=testing -e POSTGRES_DB=ingestion_test -p 127.0.0.1:5544:5432 postgres:17-bookworm
docker exec ingestion-tests pg_isready -U ingestion -d ingestion_test
TEST_DATABASE_URL=postgresql://ingestion:testing@localhost:5544/ingestion_test npm run test:integration
npm test
npm run test:browser
npm run format:check
npm run lint
npm run typecheck
npm run build
bash -n scripts/stack-restart.sh
git diff --check
docker rm -f -v ingestion-tests
```

All 22 integration and 10 browser cases passed locally, with no skips. The hosted sandbox failure did not reproduce on this host; this is not proof of hosted recovery. The known pg busy-client deprecation warning remains. Cleanup restored all original identities: 32 containers, 14 volumes, 11 networks; owner API start/finish timestamps and healthy state were unchanged. No owner lifecycle command was run.

Final local checks: **126 unit passed (7 files), 22 integration passed (1 file), 10 browser passed (1 file): 158 passed, zero failed/skipped**. Formatting, lint, typecheck, build, Bash syntax, and staged/unstaged diff checks passed. The six pipeline regressions prove exit/log behavior, not execution of a GitHub job or artifact upload. Reviewed the final four-file diff for unrelated changes and security implications: only workflow shell/pipeline behavior, unit probes, README, and this report changed. No additional privileges, security relaxation, dependencies, timeout increases, test weakening, or production code changes.

**Recommendation: CHANGES REQUESTED for overall hosted-CI remediation.** False-green exit propagation is fixed and locally regression-tested; the separate Linux sandbox environment still needs a verified sandbox-preserving solution and an honest hosted rerun. No production behavior was changed, and no commit, push, deployment, or owner-stack restart was performed. Historical local integration/lifecycle passes remain valid within their environments; hosted green conclusions are not equivalent evidence.

## Sandboxed CI implementation and local validation — 13 October 2026

Implemented CI/test infrastructure only. The workflow pins `ubuntu-24.04`, preserves explicit Bash/pipefail and failure artifact handling, keeps unit/static checks on the host, and runs integration/browser tests inside a dedicated non-root image. `compose.ci.yaml` is independent of production Compose: it creates only disposable PostgreSQL and test services, with no published ports and an internal isolated-gateway bridge. `scripts/ci-run.sh` generates its project identity, sanitizes Compose selectors, rejects existing project/name/image collisions before mutation, and uses explicit file/project flags. Normal exit and INT/TERM handling capture artifacts and remove the owned one-off container, project network/volume, and exact project-built image. Forced termination/daemon failure can interrupt cleanup; diagnostics and project identity remain available.

### Image evidence

Executed `docker buildx imagetools inspect mcr.microsoft.com/playwright:v1.63.0-noble` against Microsoft's registry. Verified manifest-index digest: `sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27`. Reported platform manifests: amd64 `sha256:bc6ab0d6d44ff4826e4cb8c1e6d801e185bfc42bb0753f8e2a30efc70db054c7`; arm64 `sha256:a0f4498920a5dbac63196d9140ed738ef00470f27e2e74029abd8850b7bd5717`. The CI Dockerfile pins the index digest and checks that the installed locked Playwright package is exactly 1.63.0. No digest was guessed; no production image reference was changed.

### Security and diagnostics

The test runtime uses `pwuser` (observed UID 1001), `cap_drop: [ALL]`, no-new-privileges, the existing seccomp policy plus one CI-only change, 256 MiB private shared memory, a 2 GiB memory bound, and a 256-PID bound. No privileged mode, added capabilities, host network/IPC/PID sharing, Docker socket mount, unconfined profile, host-policy change, or browser sandbox bypass was used. Build-time package installation occurs separately from the isolated runtime and uses the lockfile. The existing production browser/user/seccomp/network settings remain unchanged.

The initial strict probe failed at Chromium's `sys_chroot` call. Inspection established that the original profile permits `chroot` only when CAP_SYS_CHROOT is retained, incompatible with dropping all outer capabilities. `scripts/ci-seccomp.mjs` derives a temporary profile and removes only that rule's capability condition; all other rules are unchanged. Chromium can then chroot inside its own user namespace while outer kernel capability checks still deny the operation. A separate non-root, zero-capability probe executing `chroot /` received Operation not permitted. A unit comparison verifies that no other policy rule changes. This targeted syscall allowance increases the seccomp-permitted operation set by one; it does not grant outer capabilities or disable kernel checks.

The first evidence probe also hit an unsupported CDP command-line method. The final check uses `SystemInfo.getProcessInfo` and actual `/proc` metadata instead. Chromium Headless Shell does not expose `chrome://sandbox` here, so a successful page load or UI substitute is not accepted as proof. For both default `launch` and `launchServer`/connect, the final verifier requires non-root processes, zero effective capabilities, NoNewPrivs=1, seccomp filter mode, no bypass arguments, at least one renderer, distinct renderer user/PID/network namespace identities, and more renderer seccomp filters than the browser's Docker baseline. Inconclusive evidence fails closed. It emits only bounded security metadata, not environment values or full command lines.

Actual final evidence for both launch modes: browser filter count 1; renderer filter count 2; distinct renderer namespace identities; non-root UID 1001 and zero outer capabilities. Namespace identifiers may be reused after processes exit and are not compared across independent launches. Seven negative unit cases reject missing evidence/renderers/namespaces, shared namespace/filter state, root execution, and bypass arguments. Production launch-error classification still maps generic failures to BROWSER_TIMEOUT; the CI preflight exposes failures directly without altering application behavior.

### Executed validation

Before mutation, Docker inventories and project/name/port checks were performed. Temporary probes used a uniquely named, network-disabled container removed on exit. The actual final command was `bash scripts/ci-run.sh /tmp/ingestion-ci-final-artifacts-3`; it completed with exit 0 against project `ingestion-ci-1791914497-59475`, using the current CI Dockerfile/profile/network/test runner. Integration and browser commands run once per invocation with default and JSON reporters. Post-run assertions require exact expected counts, success=true, zero failures, zero pending, and zero TODO tests; there are no suite retries. Existing tests intentionally exercise ingestion retry behavior, which is distinct from retrying a failing suite into a pass.

The initial CI run passed both suites but Compose left its named one-off container behind. Cleanup was corrected to check that container's project label and explicitly remove it, then remove only the exact generated image tag. The leftover was removed, and subsequent full CI-container runs verified cleanup. Initial static checking found a missing lint-visible URL import; corrected before final static checks. These initial defects are recorded rather than treated as clean first-pass results. INT/TERM cleanup traps were added afterward and shell-checked; cancellation behavior was not independently injected.

Final results: **136 unit tests passed (8 files), 22 integration passed (1 file), 10 browser passed (1 file): 168 passed, zero failed/skipped**. Six retained pipeline regressions prove exit 23 propagation and retained logs for intentionally failing fake commands; none intentionally fails the production workflow. Formatting, lint, strict typecheck, build, Bash syntax, Compose configuration/build, real container execution, and staged/unstaged diff checks passed. Integration JSON recorded total=22/passed=22/failed=0/pending=0/TODO=0; browser JSON recorded 10/10/0/0/0. The known pg busy-client deprecation warning remains.

Final inventories restored all original 32 container, 14 volume, and 11 network identities. The owner API lifecycle timestamps and healthy state were unchanged; read-only before/after comparisons matched product/variant identities, current offers/last-change state, and complete history rows. No owner lifecycle command or database write was executed. Generated project images and disposable database state were removed; Docker build cache and local artifact files are retained for efficient review/reproduction. No production code, migration, production Compose/Dockerfile, dependency, or security policy was edited.

**Local CI implementation validation: PASS. Hosted compatibility: NOT YET VERIFIED.** Local execution used Linux/arm64 under Colima, not GitHub's Ubuntu/amd64 kernel/AppArmor environment. The new hosted job will fail honestly if sandbox launch/evidence is unavailable. A successful owner-authorized hosted run is still required; this is not final project completion. After review, the owner must commit/push the approved changes and inspect the Development checks run for sandbox evidence and complete 136/22/10 test counts. No commit, push, hosted execution, or deployment was performed here.

## Hosted CI reconciliation — 13 October 2026

This addendum supersedes the preceding stage's pending-hosted-verification status without changing its historical execution record. The read-only Definition of Done audit retrieved the actual GitHub run metadata and logs with:

```sh
gh run view 38444687594 --repo Warw0lfLabs/web-data-ingestion-engine --json conclusion,headSha,jobs,url
gh run view 38444687594 --repo Warw0lfLabs/web-data-ingestion-engine --log
```

[Development checks run 38444687594](https://github.com/Warw0lfLabs/web-data-ingestion-engine/actions/runs/38444687594) concluded success for commit `0a1b314afda8643418987a16f4035112be2e79e2`. Actual hosted logs showed **136 unit tests in eight files, 22 integration tests in one file, and 10 browser tests in one file passed: 168 total**. Integration/browser report assertions require zero failed, pending, or TODO tests. Formatting, lint, typecheck, build, Compose configuration, and image-build steps also succeeded. No tests or hosted workflow were rerun for this documentation reconciliation.

The hosted Ubuntu 24.04.5/amd64 run emitted sandbox evidence for both direct launch and server launch/connect at 18:12:37 UTC: UID 1001, browser seccomp filter count 1, renderer filter count 2. The verifier also required zero effective capabilities, no-new-privileges, separate renderer user/PID/network namespaces, and absence of sandbox-bypass arguments before accepting those records. The logged workflow shell included `-e -o pipefail`; all six pipeline propagation regressions passed. Failure-only artifact upload was skipped on this successful run, so it is not evidence of that upload branch executing.

**Technical CI validation: PASS for this commit and tested environment. Full Definition of Done: INCOMPLETE.** Final clean-checkout owner smoke testing and explicit owner acceptance are **PENDING**; delivery and owner acknowledgment of the architecture/operation walkthrough are **PENDING**. Earlier owner restart/readiness evidence is preserved but does not establish clean-state final acceptance or exact data preservation without a baseline. Use the [pending owner checklist](manual-testing.md#final-owner-acceptance-checklist--pending).

The historical false-green run remains an incident with eight failures, not a test pass. Native whole-stack `docker compose restart` remains unsupported and unfixed; `scripts/stack-restart.sh` is the supported workflow. V1 demonstration restrictions, unvalidated production deployment, pg compatibility warning, and forced-termination cleanup limitations remain. The recent CI container/seccomp changes received a focused independent read-only review with no blocking finding; see the [security addendum](security-review.md#ci-container-and-seccomp-review--13-october-2026).
