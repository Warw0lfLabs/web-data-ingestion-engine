# Manual testing

This is a historical stage report: its test totals and environment describe that stage. Current implementation/checks are recorded in [final validation](validation.md); later corrections do not rewrite the earlier evidence.

## Status and scope

**PASSED after fixes — 6 October 2026.** The operator scenarios below were executed against the actual Docker Compose application and real HTTP API. Initial failures and fixes are recorded below. This report records the manual-testing run; subsequent checks are documented separately.

## Environment

- Host: macOS ARM64, Colima Docker endpoint, Node.js v22.23.2.
- Docker Engine: 29.5.2, Linux/aarch64; Docker Compose: 5.5.1.
- API/worker image runtime: Node.js v24.21.0; Playwright server runtime: v24.20.0.
- PostgreSQL: `postgres:17-bookworm`; Chromium: bundled in the Playwright 1.63.0 container image.
- Dedicated Compose project: `ingestion-manual-test`; localhost API: `http://127.0.0.1:3000`.
- Operator configuration: `.env` from the documented example, with its development trigger token. Tokens were not copied into this report.
- A separate existing disposable `ingestion-development-tests` container was used for automated regressions, never for the manual application workflows.

The project name had no existing containers or volume before startup. After the first diagnostic run, its volume was removed and a second clean environment was built. Before the successful initial manual ingestion, real API responses showed zero runs and zero products. The scheduler remained enabled throughout testing; its three subsequent catch-up runs are included in the observed totals.

## Setup and commands actually used

README was read before testing. The documented `npm ci`, conditional copy of `.env.example` to `.env`, and `npx playwright install chromium` commands succeeded. Compose startup used detached mode and a dedicated project name:

```sh
docker compose -p ingestion-manual-test up --build -d
# After the networking/health fixes and deletion of diagnostic state:
docker compose -p ingestion-manual-test up --build -d --wait
docker compose -p ingestion-manual-test ps -a
curl --fail-with-body -sS http://127.0.0.1:3000/health/live
curl --fail-with-body -sS http://127.0.0.1:3000/health/ready
```

For API workflows, a disposable operator script issued real Node `fetch` requests, using the token from `.env`. It printed/recorded response bodies without request headers and polled `/v1/runs/:id` every 150 ms, with a two-minute timeout. It did not invoke application ingestion functions or automated test suites.. It exercised the baseline, three source ingestions, unchanged/price/availability scenarios, transient retry, invalid inputs, and pagination. The helper was outside the repository and is not a supported project command.

Manual triggers sent `POST /v1/sources/:id/runs` with `{}`, JSON content type, and the valid bearer token. Every accepted run was inspected through its real HTTP status endpoint until terminal; completion was never assumed from the trigger response.

### Disposable fixture scenarios

The production fixture server has no HTTP mutation endpoint. To change owned demonstration data, a temporary Compose override changed only the fixture-server command, calling its existing in-process state helper. No product, offer, or history rows were edited to manufacture results.

The temporary fixture override contained the following configuration. Paths in the commands below are generalized as `$FIXTURE_OVERRIDE`; they refer to the disposable file used during this run, not a shipped repository file:

```yaml
services:
  fixture-server:
    command:
      - node
      - --input-type=module
      - -e
      - "import {fixtureServer} from './dist/entrypoints/fixtures.js';const fixture=await fixtureServer(8080,'0.0.0.0');fixture.states.set('structured',JSON.parse(process.env.MANUAL_FIXTURE_STATE || '{}'));"
    environment:
      MANUAL_FIXTURE_STATE: ${MANUAL_FIXTURE_STATE}
```

Actual scenario changes used:

```sh
MANUAL_FIXTURE_STATE='{"price":"17.00"}' docker compose -p ingestion-manual-test -f compose.yaml -f $FIXTURE_OVERRIDE up -d --no-deps --wait fixture-server
MANUAL_FIXTURE_STATE='{"price":"17.00","availability":"https://schema.org/OutOfStock"}' docker compose -p ingestion-manual-test -f compose.yaml -f $FIXTURE_OVERRIDE up -d --no-deps --wait fixture-server
MANUAL_FIXTURE_STATE='{"price":"17.00","availability":"https://schema.org/OutOfStock","failures":1}' docker compose -p ingestion-manual-test -f compose.yaml -f $FIXTURE_OVERRIDE up -d --no-deps --wait fixture-server
```

The retry scenario was later repeated with `--force-recreate` to reset its consumed failure counter when retesting the snapshot fix. Fixture health probes use `/health/live` and do not consume scenario failures.

## Scenario results

| Scenario                      | Expected                                              | Actual evidence                                                                                                                                       | Result             |
| ----------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| Clean startup                 | All long-lived services healthy; migration exits zero | PostgreSQL, API, worker, fixture-server, browser all healthy; migrate `Exited (0)` after fixes                                                        | Passed             |
| Migrations                    | Application and Graphile schemas installed            | `app_migrations` contains `001_initial`; Graphile migration count is 20; restart migration exits zero                                                 | Passed             |
| Liveness/readiness            | HTTP 200 with healthy status                          | `{"status":"ok"}` and `{"status":"ready"}`, including after restart                                                                                   | Passed             |
| Swagger/OpenAPI               | Documentation loads and includes required routes      | `/docs` and `/docs/json` HTTP 200; OpenAPI 3.0.3 with ten required operations; real Chromium rendered all ten operations and screenshot was inspected | Passed             |
| Sources                       | Three source summaries and structured source details  | HTTP 200; structured/dom/javascript enabled; only javascript reports browser enabled                                                                  | Passed             |
| Initial manual structured run | Queued/running/succeeded; persisted initial offer     | Initial run below observed all three states; accepted 1, changed 1, extractor `jsonld`                                                                | Passed             |
| Unchanged rerun               | Freshness advances, no duplicate history              | Accepted 1, changed 0; history remained one row; last-observed advanced while last-changed stayed unchanged                                           | Passed             |
| Price change                  | Current price changes, old history retained           | Current price became `17.000000`; history count 2, original row intact                                                                                | Passed             |
| Availability change           | Current availability changes, history grows once      | Current availability became `out_of_stock`; history count 3, earlier two rows intact                                                                  | Passed             |
| Static DOM                    | Successful CSS extraction and persistence             | Manual run succeeded, accepted 1, extractor `dom`; `lamp-1`, `29.500000`, in stock                                                                    | Passed             |
| JavaScript fixture            | Actual remote Compose Playwright fallback succeeds    | Manual run succeeded, accepted 1, extractor `browser`; `chair-1`, `49.000000`, in stock                                                               | Passed             |
| Transient failure             | Retry state, delayed second attempt, eventual success | Actual HTTP 503; first attempt persisted retry time; second attempt succeeded; no extra offer history                                                 | Passed             |
| Overlap prevention            | Conflict while source has an active run               | Structured and javascript conflicting triggers returned HTTP 409, `SOURCE_BUSY`                                                                       | Passed             |
| Authorization                 | Missing/invalid token rejected; valid token accepted  | HTTP 401 `UNAUTHORIZED` for both missing and invalid tokens; valid triggers returned 202                                                              | Passed             |
| Invalid/unknown input         | Structured 400/404 errors                             | Cases below returned stable codes and request IDs, before and after snapshot fix                                                                      | Passed             |
| Pagination                    | Bounded pages, unique traversal, terminal cursor      | `/v1/runs?limit=2` traversed 11 distinct runs over six pages, then null cursor                                                                        | Passed             |
| Run-detail consistency        | Status, attempt counter, attempt rows agree           | After fix, 38 real HTTP polls during a second retry scenario all agreed                                                                               | Passed             |
| Logs                          | No unexpected crashes, stack traces, token leaks      | Post-fix log inspection described below; restart counts zero                                                                                          | Passed             |
| Stop/restart persistence      | Same products, offers, histories and runs survive     | Three products and twelve runs; complete API snapshot digest identical before/after restart                                                           | Passed             |
| README instructions           | Commands lead to a usable environment                 | Original startup exposed defects; corrected startup and stop/start commands were executed successfully                                                | Passed after fixes |

The DOM run finished before a second immediate trigger, so that second trigger legitimately returned 202 and produced another successful run. This was not counted as overlap rejection; actual 409 responses were observed for still-active structured/javascript runs.

## Concrete ingestion/history evidence

Structured product ID: `00385960-ca8e-47ab-9f47-05c3439db269`.

Default variant ID: `f9805f70-3ca6-4633-9adc-9cab4b9f8a1f`.

| Manual scenario           | Run ID                                 | Terminal status | Attempts | Changed | Structured history count |
| ------------------------- | -------------------------------------- | --------------- | -------- | ------- | ------------------------ |
| Initial                   | `fdbead4c-d496-4374-a01b-869d38ff98a5` | succeeded       | 1        | 1       | 1                        |
| Unchanged                 | `701d1d91-8044-4ae4-9609-215b5c54d6b6` | succeeded       | 1        | 0       | 1                        |
| Price                     | `24588c9c-e17d-422a-a566-d3e42b650633` | succeeded       | 1        | 1       | 2                        |
| Availability              | `c9063568-a24e-45bc-a2ea-89f5e7aea113` | succeeded       | 1        | 1       | 3                        |
| Transient retry           | `f03deb97-b448-42f2-98fe-377960bdbc1e` | succeeded       | 2        | 0       | 3                        |
| Snapshot-fix retry retest | `521afd63-4f74-4d62-86f4-5fabdb4303f9` | succeeded       | 2        | 0       | 3                        |

Static DOM manual run: `3d1a9224-6530-4877-89ae-50e0c3ba70fe`.

Playwright manual run: `5304ddbd-4048-4935-bacd-6ef2a5370252`.

Actual `/v1/variants/:id/history` responses, independently confirmed with PostgreSQL, contained:

| History ID | Price     | Availability | Observed at (UTC)        |
| ---------- | --------- | ------------ | ------------------------ |
| 1          | 19.990000 | in_stock     | 2026-10-06T11:23:45.088Z |
| 4          | 17.000000 | in_stock     | 2026-10-06T11:24:41.924Z |
| 5          | 17.000000 | out_of_stock | 2026-10-06T11:25:10.330Z |

History IDs 2 and 3 belong to other fixture variants; history uses one global identity sequence. Final structured current state was `17.000000 USD`, `out_of_stock`, with last-observed `2026-10-06T11:29:23.127Z` and last-changed `2026-10-06T11:25:10.330Z`.

For the first retry, attempt 1 finished with `HTTP_503` at `11:26:43.148Z` and recorded `retry_at=11:26:46.723Z`. Attempt 2 started at `11:26:47.213Z` and completed successfully at `11:26:47.245Z`. Polling actually observed running → retrying → running → succeeded. No direct job execution or due-time modification was used in manual testing.

## Invalid-input evidence

- Missing source, nonexistent run/product/variant UUID: HTTP 404, `NOT_FOUND`, request ID.
- `/v1/products?limit=101`: HTTP 400, `INVALID_REQUEST`.
- `/v1/runs?cursor=bad-cursor`: HTTP 400, `INVALID_CURSOR`.
- `/v1/runs/not-a-uuid`: HTTP 400, `INVALID_REQUEST`.
- Manual trigger body containing an arbitrary `url`: HTTP 400, `INVALID_REQUEST`.
- Missing/invalid bearer token: HTTP 401, `UNAUTHORIZED`.

## Defects discovered and fixes

### 1. Published API port unavailable on internal-only network

Original Compose startup reported the API running, but host `curl` could not connect. Docker inspection showed a configured host binding with `NetworkSettings.Ports["3000/tcp"]=null`; `docker compose port api 3000` reported `invalid IP:0`. In-container readiness returned 200.

Fixed by attaching only the API to a dedicated ingress bridge in addition to the internal data network. Retest showed `127.0.0.1:3000->3000/tcp`, real host HTTP 200, and functional Swagger/API workflows.

### 2. Worker could not resolve/reach the Playwright server

Original scheduled javascript ingestion exhausted retries with `BROWSER_TIMEOUT`. A direct diagnostic connection from the real worker reported `getaddrinfo EAI_AGAIN browser`: worker and browser had no shared network.

Fixed with a dedicated internal browser-control network shared by worker/browser, while keeping browser off the PostgreSQL/API networks. Added steady-state health checks and healthy-service dependencies. Real remote browser ingestion subsequently succeeded; public browser scraping was not added.

The fixture health endpoint is separate from scenario pages, so health checks cannot consume an intentionally seeded 503.

### 3. Run detail combined snapshots from different transitions

During the fast DOM workflow, a real response for run `1fe83a72-e4e7-47dc-90ff-56845bfefc4c` reported `status=queued`, `attempt=0`, but already included attempt 1. The endpoint queried the run and its child records independently while the worker committed a transition between queries.

Fixed by reading all run-detail fields in one read-only repeatable-read transaction. Rebuilt the Compose API and repeated a real transient-retry workflow: all 38 polled responses had matching run attempt counters and attempt rows.

## Regression tests and changed files

- `tests/unit/compose.test.ts`: shared worker/browser control network, publishable API ingress, browser/database separation, required service health checks.
- `tests/unit/fixture-health.test.ts`: health probes do not consume seeded failures.
- `tests/integration/engine.test.ts`: concurrent worker-style run/attempt updates while repeatedly reading API run details; responses remain consistent.

Implementation/configuration changes: `compose.yaml`, `Dockerfile`, `docker/worker-health.mjs`, `src/entrypoints/fixtures.ts`, `src/modules/api/app.ts`.

Test/dependency changes: the three test files above, `package.json`, `package-lock.json` (direct development dependency on YAML parsing for the Compose regression).

Documentation changes: `README.md`, `docs/architecture.md`, this report. README now documents health expectations, detached startup with `--wait`, persistent stop/restart, and intentional volume deletion. Architecture notes describe the corrected network layout and run-detail snapshot.

## Automated checks after fixes

These are separate corroborating checks, not substitutes for the manual evidence:

- Unit/fixture/network/configuration regressions: 24 passed.
- Real PostgreSQL/API integration tests: 16 passed, including concurrent snapshot regression.
- Playwright extraction tests: 6 passed.
- Lint, strict type check, TypeScript build: passed.
- Compose full image build/startup: passed after network fixes; API image rebuilt and became healthy after snapshot fix.
- Formatting check: passed after report preparation.

## Operational log inspection

Collected actual Compose logs before fixes, during workflows, and after stop/restart. Post-fix application logs contained no unexpected exceptions, stack traces, `BROWSER_TIMEOUT`, worker crashes, or error/fatal Pino entries. Two warning entries corresponded exactly to the two intentionally induced `HTTP_503` first attempts.

Searching captured service logs for the configured trigger token and `Bearer ` found zero occurrences. This is an operational observation for this workflow, not a complete security audit.

PostgreSQL logged one first-bootstrap missing `graphile_worker.migrations` relation during Graphile's schema probe. The installed library explicitly handles missing-relation SQLSTATE 42P01 and bootstraps the schema; migrations then exited zero and the table contained 20 migrations. It did not recur during application workflows or restart. Normal PostgreSQL initialization and requested shutdown messages were also present.

Image builds emitted the dependency deprecation notice for `whatwg-encoding` and the local missing-buildx/classic-builder notice. Neither was a runtime crash. All long-lived containers had restart count zero; the deliberate stop/start is not a crash restart.

## Restart, cleanup, and retained evidence

Executed:

```sh
docker compose -p ingestion-manual-test stop
docker compose -p ingestion-manual-test start --wait
```

Real API snapshots of all products, variant/current offers, histories, and run summaries showed three products and twelve runs before and after. Both complete snapshots had SHA-256:

```text
9317d1fe2b593494ac776269b3f28f61075f559487905ab8158372fe0035e01b
```

After restart, every long-lived service was healthy, migrations exited zero again, and both health endpoints returned 200.

Cleanup used `docker compose -p ingestion-manual-test down -v`. The dedicated application containers, networks, and PostgreSQL volume were removed. No manual-test application database was preserved. The separate automated-test database container was stopped; it is retained for reuse by the documented regression commands from development. `.env` remains local operator configuration, not application data.

At the time of this run, response/log captures, disposable operator helpers, and a Swagger screenshot were retained outside the repository as review evidence. They were not application storage or published repository artifacts, and contained no copied authorization headers.

## Known limitations

- Whole-stack `docker compose restart` can fail the one-shot migration service with a transient Docker DNS error; successful recovery does not fix the underlying restart behavior. See the owner-reported addendum below.
- Only controlled fixture sources were manually exercised; no public scraping or adversarial security audit was performed.
- Source price/availability changes and one-shot failures require an operator fixture override; there is intentionally no public mutation endpoint.
- Health checks confirm service readiness/worker ownership, not progress of every background task.
- Host-only setup was not end-to-end tested; the complete Compose setup was the application under test.
- Manual pagination covered run history at limit two; automated tests provide additional pagination coverage.
- Infrastructure crash-lock recovery, worker termination mid-page, and long-duration operation were not manually tested in this stage.
- This report does not establish production deployment or long-duration operation.

## Owner-reported final smoke test: whole-stack restart

This addendum records the owner's observations supplied on 13 October 2026. It is separate from the 6 October manual-testing run above. No additional runtime validation was performed for this documentation update; exact product UUIDs, timestamp values, and logs beyond the reported error were not supplied.

The owner ran `docker compose restart`. All containers restarted, including the one-shot `migrate` service. Expected recovery was healthy long-running services and a successful migration exit. Instead, `migrate` exited with code 1:

```text
Error: getaddrinfo EAI_AGAIN postgres
```

This indicates a transient DNS resolution failure for the PostgreSQL service name during restart. The precise underlying timing cause remains undiagnosed. All long-running services eventually returned to healthy state despite the failed migration run.

Persistence inspection confirmed that all three products retained their original UUIDs, product timestamps remained consistent, and price history remained intact without duplicate records. These are owner-reported checks; no additional row counts, hashes, or timestamp values are claimed.

The owner then ran the recovery command:

```sh
docker compose up -d --wait
```

It completed successfully. The migration container exited with code 0, and all long-running services remained healthy. This successful recovery does not resolve the underlying whole-stack restart issue. For normal startup/recovery, follow the README's `up` commands and inspect `docker compose ps -a` for a successful one-shot migration exit as well as healthy long-running services. Preserve the PostgreSQL volume; deleting data is not part of this recovery procedure.

Result: **restart limitation reproduced by the owner; recovery and persistence verification succeeded; underlying behavior remains unfixed.** The earlier successful `stop` / `start --wait` test is preserved above and is a different operation.
