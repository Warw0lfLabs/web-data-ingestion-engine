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

## Supported lifecycle workflow testing — 13 October 2026

These are newly executed tests of `scripts/stack-restart.sh`, separate from the owner-reported native restart failure. Docker Compose 5.5.1 and host Node.js 22.23.2 were used. The script implements ordered stop/start and independent state verification; it does not fix native `docker compose restart` or diagnose its DNS failure.

Before mutation, Docker containers, projects, networks, volumes, and published ports were inventoried. The existing application and unrelated projects were left running. A previously absent project, `ingestion-lifecycle-20261013-1718`, used its own `postgres-data` volume and a temporary API-port override at localhost:3307. Temporary override files and the HTTP probe remained outside the repository. The committed Compose configuration and migration implementation were unchanged.

Fresh startup through `docker compose up --build -d --wait` completed successfully: five long-running services became healthy and `migrate` exited 0. Database inspection confirmed `001_initial` and 20 Graphile migrations. Real HTTP triggers and polling verified all three sources; the completed rerun recorded:

| Source     | Run ID                                 | Result/extractor    |
| ---------- | -------------------------------------- | ------------------- |
| structured | `18e9c5e4-9fe4-4224-8ab1-0a52da9a8d7c` | succeeded / jsonld  |
| dom        | `47a6e047-4dcb-4728-bc02-e70cc5dfc3b6` | succeeded / dom     |
| javascript | `9d32a32d-d2df-45da-8133-cb385482ddce` | succeeded / browser |

The fixture scheduler had already populated initial offers. Explicit triggers were unchanged ingestions; history contained one original row per variant. Baseline API snapshots captured product/variant IDs, current price/currency/availability, and complete history rows:

| Source     | Product ID                             | Variant ID                             | Current offer / history ID   |
| ---------- | -------------------------------------- | -------------------------------------- | ---------------------------- |
| structured | `dea42640-b598-4881-ad5b-fd4551eeb31c` | `9399478e-7685-4c2b-b265-9ae111cc2f8f` | 19.990000 USD / in_stock / 2 |
| dom        | `a97439cc-09c8-4f37-b0d5-6c34eff796a8` | `05035d37-21cb-4c6d-9ea9-954e88a7936f` | 29.500000 USD / in_stock / 1 |
| javascript | `50ad675b-e8ee-4774-85c5-fb8de93e35c6` | `d43be8f9-eca7-4ea6-8a29-84ef64add4a0` | 49.000000 USD / in_stock / 3 |

| Scenario                                                          | Actual result                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Two ordinary script restarts, invoked from outside the repository | Exit 0 each; migration exit 0; all required services running/healthy; snapshots unchanged                                                                                                                                                                          |
| Temporary migration command exits 23                              | Script exit 1 with migration-state diagnostics; API and worker remained stopped; no false success                                                                                                                                                                  |
| Restore normal migration command and rerun                        | Script exit 0; snapshots unchanged                                                                                                                                                                                                                                 |
| Controlled PostgreSQL readiness gate                              | Temporary health check required an absent marker; while PostgreSQL was starting, migration start timestamp remained unchanged and API/worker were stopped. Creating the marker released the gate; script exited 0, migration ran successfully, snapshots unchanged |
| Restore normal health check and rerun                             | Script exit 0; snapshots unchanged                                                                                                                                                                                                                                 |

Baseline and final snapshots compared equal, including history timestamps and run references. Canonical JSON (sorted keys, compact separators) SHA-256 was `783902b591672bc5e727ec0383d30d84eb6e22e0c47b7e3d9a14606a5fde1994`. The volume remained `ingestion-lifecycle-20261013-1718_postgres-data`, including when Compose recreated containers for temporary overrides. Freshness timestamps on products/current observations were not asserted invariant after unchanged ingestion; offer-history rows were.

An initial probe pass encountered `UND_ERR_SOCKET` on its final snapshot because its HTTP connection survived an intentional restart in the client pool. The disposable probe was changed to request fresh connections and the complete workflow rerun passed. No application change was made. Initial mocked-test path assertions also needed physical-path normalization for macOS's temporary-directory alias; all corrected regressions subsequently passed.

Captured disposable service logs contained zero example-token/runtime-password/bearer markers and zero inspected unhandled/unexpected-ingestion exception markers. This is bounded evidence, not a guarantee for arbitrary external logging. Cleanup removed only this test project's containers/networks/volume and its temporary probe/override files; the existing application remained healthy and unrelated resources were untouched.

**Supported workflow validation: PASSED.** Native whole-stack restart remains unsupported and unfixed. ShellCheck was unavailable; shell syntax, mocked regressions, and real Compose verification were performed instead. Failure can leave the stack stopped or partially started; the script preserves data and requires operator diagnosis rather than automatic migration retries.

## Final guarded lifecycle runtime validation — 13 October 2026

**Result: PASSED for the tested disposable environment.** This run exercised the final script after alternate-target acknowledgment and mandatory dependency validation were added. Environment: macOS host, Node.js 22.23.2, Docker Compose 5.5.1, Linux/arm64 containers. Existing immutable local image IDs were reused with `--no-build`; no image build or application change was performed.

Before mutation, machine-readable inventories were captured using:

```sh
docker compose ls --format json
docker ps -a --format '{{json .}}'
docker network ls --format '{{json .}}'
docker volume ls --format '{{json .}}'
```

There were 32 containers, 11 networks, and 14 volumes; existing projects included `web-data-ingestion-engine`, `auth-service-lab`, `ai-support-desk`, `core`, and `scan`. Published ports were inspected. The original ingestion API remained on localhost:3000. The newly selected project `ingestion-lifecycle-final-20261013-c77d12` had no existing containers/networks/volumes. A localhost socket check selected free port 55230. Resolved configuration confirmed that only localhost:55230 was published and the database volume was newly scoped to `ingestion-lifecycle-final-20261013-c77d12_postgres-data`, with no external volume.

Temporary files were outside the repository at `/tmp/ingestion-final-lifecycle-JCkeyo`. `isolated.yaml` assigned each service its corresponding existing immutable image ID and replaced the API ports with `ports: !override ["127.0.0.1:55230:3000"]`. The harness sanitized inherited `COMPOSE_*` variables and acknowledgment; opt-in was set only for individual disposable script invocations. The lifecycle commands below reproduce the executed arguments. `R` uses the current repository directory rather than publishing the original workstation-specific absolute path:

```sh
P=ingestion-lifecycle-final-20261013-c77d12
R=$(pwd -P)
T=/tmp/ingestion-final-lifecycle-JCkeyo

docker compose --project-directory "$R" -p "$P" -f "$R/compose.yaml" -f "$T/isolated.yaml" config --format json
docker compose --project-directory "$R" -p "$P" -f "$R/compose.yaml" -f "$T/isolated.yaml" up -d --no-build --wait

# Executed twice; each returned 0.
COMPOSE_PROJECT_NAME="$P" COMPOSE_FILE="$R/compose.yaml:$T/isolated.yaml" INGESTION_STACK_ALLOW_ALTERNATE_TARGET=1 /bin/bash "$R/scripts/stack-restart.sh"

# Weakened worker -> browser gate: service_started instead of service_healthy.
COMPOSE_PROJECT_NAME="$P" COMPOSE_FILE="$R/compose.yaml:$T/isolated.yaml:$T/weakened.yaml" INGESTION_STACK_ALLOW_ALTERNATE_TARGET=1 /bin/bash "$R/scripts/stack-restart.sh"

# Acknowledgment absent from the invocation environment.
COMPOSE_PROJECT_NAME="$P" COMPOSE_FILE="$R/compose.yaml:$T/isolated.yaml" /bin/bash "$R/scripts/stack-restart.sh"

# failure.yaml replaced only migrate.command with [node, -e, "process.exit(23)"].
COMPOSE_PROJECT_NAME="$P" COMPOSE_FILE="$R/compose.yaml:$T/isolated.yaml:$T/failure.yaml" INGESTION_STACK_ALLOW_ALTERNATE_TARGET=1 /bin/bash "$R/scripts/stack-restart.sh"

# Recovery without the failure override.
COMPOSE_PROJECT_NAME="$P" COMPOSE_FILE="$R/compose.yaml:$T/isolated.yaml" INGESTION_STACK_ALLOW_ALTERNATE_TARGET=1 /bin/bash "$R/scripts/stack-restart.sh"

docker compose --project-directory "$R" -p "$P" -f "$R/compose.yaml" -f "$T/isolated.yaml" down --volumes
```

Resolved JSON showed all five edges with `required: true`: migrate → postgres `service_healthy`; API → migrate and worker → migrate `service_completed_successfully`; worker → fixture-server and worker → browser `service_healthy`. Fresh startup and both script restarts produced migrate exited/0 and five running/healthy services. Database queries confirmed `001_initial` in `app_migrations` and 20 Graphile migrations.

Authenticated real HTTP POSTs to `/v1/sources/{source}/runs` were followed by polling `/v1/runs/{id}` until terminal state:

| Source     | Run ID                                 | Actual result |
| ---------- | -------------------------------------- | ------------- |
| structured | `e4d546b5-f6a4-4d6d-8758-1d783da69f24` | succeeded     |
| dom        | `db340969-b06b-41fe-91a1-04f4187be37e` | succeeded     |
| javascript | `51a24ee4-fe4c-4ce6-8cfb-2b83ec4955a7` | succeeded     |

The scheduler had populated the initial offers; the explicit runs observed unchanged fixtures. Baseline and subsequent read-only PostgreSQL queries compared product IDs/source keys/titles, variant IDs/product keys, current price/currency/availability/last-change timestamps, and **every field of every history row**, including observation timestamps and run references. Snapshots matched after both restarts and recovery: three products, three variants, three offers, three history rows, no duplicates. Current observation/product freshness fields were not asserted unchanged because scheduled ingestion can refresh them.

| Source     | Product ID                             | Variant ID                             | Offer / history ID       |
| ---------- | -------------------------------------- | -------------------------------------- | ------------------------ |
| structured | `691e3b0b-e965-4ce5-bcee-592ca9c8c9dc` | `66532289-1d21-4df7-b114-b6d124320b95` | 19.99 USD / in_stock / 1 |
| dom        | `cc9f01ea-139d-49e1-8a05-8bc80af1c4f3` | `c0d8d00d-3ac8-409a-aa09-66d57b2154d4` | 29.5 USD / in_stock / 2  |
| javascript | `93c623af-0fb6-47ab-a28d-9c76a7671c90` | `61cb2ed1-e782-4ed8-ab25-ebb73c40eee2` | 49 USD / in_stock / 3    |

The matching snapshot SHA-256 (Node.js `JSON.stringify` of the ordered query result) was `28039f1249b413386cffed99c0da583692fe64850218314684345c388637f1b7`. Read-only SQL evidence was obtained with `docker exec "$P-postgres-1" psql -U ingestion -d ingestion -At -c ...`; container evidence used `docker ps -aq --filter label=com.docker.compose.project=...` followed by `docker inspect --format '{{json .}}' ID`. Before/after rejection snapshots included IDs, status, exit code, health, mount names, and start/finish timestamps.

The catalog snapshot SQL used for both disposable and owner read-only evidence was:

```sql
SELECT json_build_object(
  'products', (SELECT json_agg(x ORDER BY id) FROM
    (SELECT id,source_id,external_key,title FROM products) x),
  'variants', (SELECT json_agg(x ORDER BY id) FROM
    (SELECT id,product_id,external_key FROM variants) x),
  'offers', (SELECT json_agg(x ORDER BY variant_id) FROM
    (SELECT variant_id,price,currency,availability,last_changed_at FROM offer_current) x),
  'history', (SELECT json_agg(x ORDER BY id) FROM offer_history x)
);
```

The migration evidence query was `SELECT name FROM app_migrations ORDER BY id; SELECT count(*) FROM graphile_worker.migrations;`. The temporary Node harness sent JSON-body `{}` POST requests with a bearer token read only into memory from the disposable API environment; it did not print that token. Completed run page results recorded extractors `jsonld`, `dom`, and `browser`, respectively, with one accepted record, zero rejected records, and zero changes per explicit unchanged run.

The weakened gate returned 1 before “Stopping stack”; missing acknowledgment also returned 1 before that phase. All disposable container state/start/finish snapshots remained identical across both refusals. Migration injection returned 1 with `Service migrate: state=exited, exit=23`; no success message appeared, and API/worker remained stopped. Removing the failure override recovered with exit 0 and preserved the catalog/history snapshot. Failure left a partially running stack, as documented.

Three unexpected **probe errors** were explicitly corrected: the initial read-only catalog query used nonexistent column names (before any Docker mutation); a later migration query used `pgmigrations` instead of `app_migrations`; and an owner-state comparison differed only because JSON serialization omitted an undefined migrator health field. Schema-correct queries and normalized JSON comparison passed. The latter two checks continued against the same disposable environment; these errors were not application defects or successful scenarios.

Original-owner container IDs, start/finish timestamps, state, and volume mounts compared equal; its catalog/history snapshot also matched. `/health/ready` returned `{"status":"ready"}` before testing, after recovery, and after cleanup. No owner lifecycle command or ingestion trigger was executed. Disposable logs contained zero inspected `EAI_AGAIN`, `Unhandled`, or `Unexpected ingestion failure` markers; this bounded inspection is not a security review.

Cleanup removed only the six disposable containers, five disposable networks, and its new database volume. Final inventories exactly matched all original container/network/volume identities and counts. Shared images were retained. Temporary evidence files were retained locally to support review, without saving resolved credential-bearing Compose configuration. This run validates the final workflow on the tested environment; it does not fix native whole-stack restart, certify arbitrary alternate configurations, or prove every timing/interruption scenario.

## Owner-performed supported-workflow smoke test — 13 October 2026

The owner reported independently executing `scripts/stack-restart.sh` against the original local stack with exit code 0. Post-restart evidence supplied by the owner: five long-running services healthy, migrator exited 0, API readiness HTTP 200, and all nine PostgreSQL tables present. Reported data counts were products=3, variants=3, offer_current=3, offer_history=3, and ingestion_runs=6.

**Owner-reported smoke result: PASSED for startup/readiness and the observed post-restart state.** These are owner-provided results, not commands executed during this reconciliation. No pre-restart owner-data baseline was supplied, so exact identity, timestamp, offer/history preservation, or absence of newly introduced duplicates across this owner restart cannot be established from these counts. The isolated validation above did compare pre/post snapshots and remains separate evidence. Native `docker compose restart` remains unsupported and unfixed; the supported workflow is `scripts/stack-restart.sh`.

<a id="final-owner-acceptance-checklist--pending"></a>

## Final owner acceptance checklist — ACCEPT

The independent owner smoke test below was performed on 13 October 2026. This section now records **owner-supplied execution evidence**, not new commands executed during this documentation update. Final acceptance was explicitly recorded on 25 October 2026 below. The 25 October reconciliation below records the additional rerun and the owner’s walkthrough waiver; the walkthrough was not delivered or acknowledged. This records V1 demonstration and portfolio acceptance, not production deployment readiness.

### Tested checkout and isolation

The owner used a separate clean checkout, `~/Projects/ingestion-owner-acceptance`, branch `main`, commit `e59964b21b77312c3fa6c6d22bd0172d05f8287b`, with a clean Git working tree before documentation changes. The application/CI baseline is `0a1b314afda8643418987a16f4035112be2e79e2`.

Disposable project `ingestion-owner-1791916200-64733` used a dynamically allocated loopback API port, five project-specific networks, and a project-specific PostgreSQL volume. Initial inventories contained no resources belonging to this project. Lifecycle commands targeted this isolated project, not the original application project.

### Observed startup and ingestion

Startup completed with five healthy long-running services and migrator exit 0. PostgreSQL migration `001_initial` was verified. `/health/live`, `/health/ready`, and `/docs/json` returned HTTP 200; the owner opened Swagger UI successfully. `/v1/sources` returned `structured`, `dom`, and `javascript`.

The scheduler had already populated the initial catalog. These manual runs observed unchanged data; they did not create the initial records. Intermediate queued/running states were not recorded as observed.

| Source     | Manual run ID                          | Trigger                | Terminal result | Extractor | Accepted / rejected / changed |
| ---------- | -------------------------------------- | ---------------------- | --------------- | --------- | ----------------------------- |
| structured | `a7693a6c-6140-4e05-b7b9-da331247d015` | HTTP 202, reused=false | succeeded       | jsonld    | 1 / 0 / 0                     |
| dom        | `a16e3213-a590-407c-88ed-52ce0c80e2e7` | HTTP 202, reused=false | succeeded       | dom       | 1 / 0 / 0                     |
| javascript | `ed5149df-885f-4d53-8773-ae8e17903ea4` | HTTP 202, reused=false | succeeded       | browser   | 1 / 0 / 0                     |

The catalog returned exactly three products. Each variant history endpoint returned exactly one original row, with IDs 1, 2, and 3 respectively:

| Listing / source   | Product ID                             | Variant ID                             | Current offer       | History ID |
| ------------------ | -------------------------------------- | -------------------------------------- | ------------------- | ---------- |
| Book / structured  | `18abe940-89f1-45e0-b6e3-1fca309d0e97` | `e0d89b5b-e7ca-4c2b-b1ec-892d26ef5a51` | USD 19.99, in_stock | 1          |
| Lamp / dom         | `5c2c2721-22ec-4409-bdda-ad90beb5369a` | `3616be73-8fb0-40f7-8ead-501ffd392bea` | USD 29.50, in_stock | 2          |
| Chair / javascript | `0d244815-11d4-4ece-bf0a-b8507e683a49` | `da5e63ae-90d0-4c58-af49-e8fa39c74984` | USD 49.00, in_stock | 3          |

The unchanged manual runs introduced no duplicate history rows. The separately requested additional unchanged structured rerun **after the history checks was not performed**; that procedural step was still pending on 13 October, distinct from the successful unchanged manual runs above. It was subsequently completed in the separate 25 October session below.

### Restart, initial health failure, and recovery

The owner captured the documented read-only catalog SQL snapshot before restart. SHA-256: `97e0830dce891e3df8d6d7c89299c80771cb083fb4ec42dfa5b3d4733a6edcad`. The supported `scripts/stack-restart.sh` succeeded for the disposable project, with migrator exit 0 and five healthy long-running services afterward.

The post-restart snapshot had exactly the same SHA-256; byte comparison returned `PERSISTENCE: PASS — snapshots identical`. The snapshot covered product/variant identities, current offer state, and complete offer history, excluding mutable freshness timestamps (the selected current-offer last-change timestamp was included).

**Initial post-restart health requests failed with HTTP 000.** The dynamic API port changed from 32771 to 32772. The owner resolved the new port using project-scoped `docker compose port api 3000`, updated the request destination, and both health endpoints then returned HTTP 200. Recovery is recorded separately from the initial failure. Future repetitions must rediscover the dynamic port after restart rather than reuse its previous value. Native `docker compose restart` remains unsupported and unfixed.

### Log inspection and cleanup

A bounded inspection of the last 200 log lines for api, worker, browser, and migrate found zero occurrences of `Unhandled`, `Unexpected ingestion failure`, `EAI_AGAIN`, `BROWSER_TIMEOUT`, `ECONNREFUSED`, `Error: `, `"level":50`, or `"level":60`. The tested token string was not found in that inspected output. This is a bounded operational observation, not a complete security audit.

Before cleanup, the owner verified six project containers, five project networks, and one project-specific PostgreSQL volume. The owner explicitly approved and executed project-scoped `docker compose down --volumes`; all six containers, five networks, and the test volume were removed. Post-cleanup inventories for the disposable project were empty.

The original `web-data-ingestion-engine` stack still showed five healthy long-running services and migrator exited 0; `web-data-ingestion-engine_postgres-data` still existed. No exact before/after original-resource identity comparison or original database-content equality is established by this evidence. Sanitized evidence files remain outside the repository in the owner's temporary evidence directory; none were copied or modified during this update.

### Additional isolated owner rerun — 25 October 2026

This later owner-supplied evidence is separate from the 13 October smoke test. Checkout revision was `e59964b21b77312c3fa6c6d22bd0172d05f8287b`; the disposable Compose project was `ingestion-owner-rerun-20261025`, using dynamically allocated loopback API port 32775. No Docker operation or test was executed during this documentation reconciliation.

The manual POST to `/v1/sources/structured/runs` initially returned HTTP 400 because the required JSON body was omitted. The corrected request with body `{}` returned HTTP 202. Run `1c8126f5-8a72-40dd-9254-5fa0ab68c077` completed with status `succeeded`, trigger `manual`, attempt 1, accepted=1, rejected=0, changed=0, and error_code=null. Its page status was `succeeded` with extractor `jsonld`.

For variant `63dbd928-380c-40a9-bb34-729ada0489da`, the history endpoint returned exactly the same single record before and after the rerun: ID 1, price `19.990000 USD`, availability `in_stock`, observed_at `2026-10-25T11:15:00.221Z`. No duplicate history entry was created. The supplied original history run ID could not be corroborated in existing repository documentation and is omitted rather than inferred. **Additional post-history unchanged structured rerun: PASS.**

The owner explicitly authorized isolated cleanup. Six containers, five networks, and the project-specific PostgreSQL volume were removed. This session does not establish an independent before/after comparison of the original application's database.

The owner explicitly waived the architecture/operations walkthrough: **SKIPPED BY OWNER**, not PASS. No walkthrough delivery or acknowledgment is claimed. Final acceptance was pending at this point in the session; the explicit decision below supersedes that status.

### Reproducible workflow reference

These instructions summarize the tested workflow; the examples are **not a verbatim transcript of every owner command**. For a future repetition, use a clean checkout at an identified commit, read README, install with `npm ci`, and copy `.env.example` only in that fresh checkout. Inventory Docker projects, containers, networks, volumes, and ports before mutation. Sanitize inherited `COMPOSE_*` selectors, select a new unused project, and use distinct absolute Compose paths. Verify no external/shared volume or owner-data mount is selected.

An isolated override replaces the API binding with a dynamically allocated loopback port:

```yaml
services:
  api:
    ports: !override ["127.0.0.1::3000"]
```

In Bash, with `OWNER_ROOT`, `OWNER_PROJECT`, and `OWNER_OVERRIDE` set to the fresh checkout, unused project, and absolute override path:

```sh
owner_compose() {
  docker compose --project-directory "$OWNER_ROOT" -p "$OWNER_PROJECT" \
    -f "$OWNER_ROOT/compose.yaml" -f "$OWNER_OVERRIDE" "$@"
}
owner_compose config --quiet
owner_compose up --build -d --wait
owner_compose ps -a
owner_compose logs --no-color migrate
owner_compose port api 3000
owner_compose exec -T postgres psql -U ingestion -d ingestion \
  -c 'SELECT name FROM app_migrations ORDER BY id;'
```

Set the API base URL from the reported loopback port. Use README's token-safe trigger procedure for each source, poll actual run IDs to terminal state with a bounded deadline, and inspect products, variants/current offers, and complete histories. Capture before/after snapshots with the SQL in the final guarded lifecycle section above. Do not print authorization headers, tokens, or resolved credential-bearing configuration.

```sh
COMPOSE_PROJECT_NAME="$OWNER_PROJECT" \
COMPOSE_FILE="$OWNER_ROOT/compose.yaml:$OWNER_OVERRIDE" \
INGESTION_STACK_ALLOW_ALTERNATE_TARGET=1 \
bash "$OWNER_ROOT/scripts/stack-restart.sh"
owner_compose ps -a
# Rediscover the port and update the API base URL before health requests.
owner_compose port api 3000
```

After explicitly verifying disposable ownership and approving cleanup, use `owner_compose down --volumes` only for that project. Check its container/network/volume label inventories are empty and inspect the original stack separately. Never use a default-project cleanup or global prune.

### Final owner decision — 25 October 2026

The project owner explicitly confirmed: “Final owner acceptance: ACCEPT for Web Data Ingestion Engine V1 with documented limitations.”

- **Project:** Web Data Ingestion Engine
- **Version:** V1
- **Decision / final owner acceptance:** ACCEPT
- **Decision date:** 2026-10-25
- **Decision authority:** Project owner
- **Canonical repository HEAD at acceptance:** `954f6b827ebee5bcdabace2e99856e6f9e15a9f4`
- **Tested isolated checkout:** `e59964b21b77312c3fa6c6d22bd0172d05f8287b`
- **Scope:** V1 demonstration and portfolio readiness, not production deployment
- **Architecture/operations walkthrough:** SKIPPED BY OWNER
- **Walkthrough acknowledgment:** SKIPPED BY OWNER
- **Additional structured rerun:** PASS

Acceptance includes the documented limitations. Native whole-stack `docker compose restart` remains unsupported; `scripts/stack-restart.sh` is the supported workflow. The initial post-restart HTTP 000 was recovered by rediscovering the dynamic API port. Exact original-application database equality was not independently established. Production readiness and unrestricted security assurance are not claimed; all other documented limitations remain in effect. This owner decision does not imply new tests or walkthrough delivery.

### Owner acceptance record

| Action                                       | Owner-supplied evidence / limitation                                                                 | Status                                  |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Clean checkout and identified revision       | main at e59964b21b77312c3fa6c6d22bd0172d05f8287b; clean working tree                                 | PASS                                    |
| Isolated project, networks, volume and port  | No initial project resources; unique project and dynamic loopback binding                            | PASS                                    |
| Startup and migrations                       | Five healthy services, migrator exit 0, 001_initial verified                                         | PASS                                    |
| Health, Swagger and source list              | HTTP 200 on three endpoints; UI opened; three sources returned                                       | PASS                                    |
| Three-source manual ingestion                | Three HTTP 202 responses and succeeded run/page results above                                        | PASS                                    |
| Catalog/current offers/history               | Three products/variants; expected offers; one history row each                                       | PASS                                    |
| Unchanged data and separate additional rerun | October 13 manual runs unchanged; October 25 before/after history remained one identical row         | PASS                                    |
| Supported restart and persistence            | Script succeeded; before/after snapshot hash and bytes identical                                     | PASS                                    |
| Post-restart health requests                 | Initial HTTP 000 on stale port; new port resolved, then both endpoints HTTP 200                      | PARTIAL — initial failure, recovered    |
| Bounded logs                                 | No listed error markers or tested token in inspected output                                          | PASS within inspected scope             |
| Disposable cleanup                           | Owner-approved removal of six containers, five networks, one volume; empty project inventories       | PASS                                    |
| Original application checks                  | Five healthy services, migrate exit 0, volume retained; exact resource/data equality not established | PARTIAL — bounded post-cleanup evidence |
| Architecture/operation walkthrough           | Explicitly waived by owner on 25 October; not delivered                                              | SKIPPED BY OWNER                        |
| Owner acknowledgment of walkthrough          | Walkthrough waived; no delivery acknowledgment claimed                                               | SKIPPED BY OWNER                        |
| Final owner acceptance decision              | Explicit project-owner decision, 2026-10-25, V1 with documented limitations                          | ACCEPT                                  |

**Final owner acceptance: ACCEPT for V1 with documented limitations.** The additional structured rerun passed on 25 October. The walkthrough and its delivery acknowledgment are SKIPPED BY OWNER, not completed. No owner acceptance gate remains pending in this record; publication actions still require separate authorization.
