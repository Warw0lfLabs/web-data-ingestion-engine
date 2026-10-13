# Final validation

This is the final-validation stage report. Later documentation finalization reorganized README, architecture, and source policy without changing application code/configuration or the recorded results below.

Status: **PASSED**, 2026-10-06. This validates V1 after implementation, manual testing, and security review. GitHub-hosted CI and production deployment were not exercised.

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

- No remote GitHub CI evidence or actual fresh Git clone; all project files remain untracked.
- Future pg 9 compatibility warning remains; installed pg 8 operation passed.
- Historical-volume upgrade and host-only deployment path were reviewed rather than independently recreated.
- This stage does not establish production TLS, image-CVE assessment, full IPv6 coverage, or support for arbitrary public browser workloads. Existing source-policy/V1 restrictions remain.

Final validation passed for the tested V1 scope, subject to the limitations above.
