# Web Data Ingestion Engine

A production-style TypeScript service that turns permitted web listings into a normalized PostgreSQL catalog with current offers and price/availability history. It demonstrates the backend work behind a small ingestion service: extraction, validation, durable jobs, transactional persistence, and a REST API.

V1 runs in a deterministic demonstration environment. Three owned sources exercise JSON-LD, CSS selectors, and JavaScript rendering; no public catalog is bundled.

## Capabilities and design

- Configurable sources with explicit origin/path rules, extraction selectors, UTC schedules, and resource limits.
- Products and variants with decimal-string prices, current availability, and history added only when the price/currency/availability tuple changes.
- Durable manual and scheduled jobs with overlap prevention, idempotency keys, page replay protection, bounded retries, and persisted run/attempt/page summaries.
- REST endpoints for sources, runs, products, and offer history, with cursor pagination and Swagger documentation.
- Structured logs, readiness checks, Docker isolation, and automated fixture/PostgreSQL/browser tests.

The architecture is a modular monolith with separate API and worker processes sharing PostgreSQL. Graphile Worker stores its queue in the same database; no additional broker is required.

```text
controlled HTTP → JSON-LD → DOM fallback → fixture-only Playwright fallback
                → normalization/validation → transactional PostgreSQL persistence
```

JSON-LD takes precedence, with matching DOM fields used where needed. Browser rendering is explicitly enabled per fixture source and used when static extraction yields no valid offers or rejects candidates; it is not a response to access denial.

**Stack:** Node.js/TypeScript, Fastify, PostgreSQL with `pg` and node-pg-migrate, Graphile Worker, Cheerio, Playwright, TypeBox/Ajv, Pino, Vitest, Docker Compose, and GitHub Actions.

## Quick start

Prerequisites: Node.js 24 LTS recommended (supported >=22.19), Docker Engine 28+ with Compose, and a running Docker daemon. Port 3000 must be available. Run commands from the repository root.

```sh
npm ci
cp .env.example .env
docker compose up --build -d --wait
docker compose ps -a
```

Copy the example only for initial setup; preserve an existing local configuration. Compose builds the PostgreSQL bootstrap into its image and runs migrations automatically. Five long-lived services should be healthy; `migrate` should show `Exited (0)`. No host database or host Chromium installation is needed for this Compose workflow.

```sh
curl --fail-with-body -sS http://127.0.0.1:3000/health/live
curl --fail-with-body -sS http://127.0.0.1:3000/health/ready
curl --fail-with-body -sS http://127.0.0.1:3000/v1/sources
node --env-file=.env --input-type=module -e 'const r=await fetch("http://127.0.0.1:3000/v1/sources/structured/runs",{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${process.env.API_TOKEN}`},body:"{}"});console.log(r.status,await r.text())'
```

A successful trigger returns HTTP 202 with `id` and `reused`. Open [Swagger UI](http://127.0.0.1:3000/docs) to inspect `GET /v1/runs/{id}` using that run ID. Poll until `succeeded`, `partial`, or `failed`; `queued`, `running`, and `retrying` are nonterminal. Fast jobs may complete before the first poll. Scheduled catch-up jobs may already have populated data.

In Swagger, use `GET /v1/products`, copy a product ID into `GET /v1/products/{id}`, then use a returned variant ID in `GET /v1/variants/{id}/history`. Product detail includes current offers and observation/change timestamps. For another page, supply the returned `nextCursor` to the same endpoint with the same filters. Use Swagger's **Authorize** control with `API_TOKEN` for further triggers.

| Source ID    | Demonstration                  | Initial offer       |
| ------------ | ------------------------------ | ------------------- |
| `structured` | JSON-LD extraction             | 19.99 USD, in stock |
| `dom`        | Static CSS selectors           | 29.50 USD, in stock |
| `javascript` | Playwright renders the listing | 49.00 USD, in stock |

Trigger `dom` or `javascript` through the same endpoint. Price changes, availability changes, transient errors, and unchanged reruns are exercised with in-process fixture helpers in tests and recorded operator workflows; there is no public fixture-mutation endpoint.

Stop/restart while preserving PostgreSQL data:

```sh
docker compose stop
docker compose start --wait
```

`docker compose down` removes the stack but retains its named database volume. To discard disposable application data:

```sh
docker compose down -v
```

The example token and database passwords are local demonstration credentials. Choose an operator-managed token before exposing the API; public reads and Swagger are intentionally unauthenticated.

## REST API

Swagger at `/docs` and generated [OpenAPI JSON](http://127.0.0.1:3000/docs/json) are the canonical detailed API reference.

| Endpoint                                   | Purpose                                                                      |
| ------------------------------------------ | ---------------------------------------------------------------------------- |
| `GET /health/live`, `GET /health/ready`    | Process liveness and database/schema readiness                               |
| `GET /v1/sources`, `GET /v1/sources/:id`   | Read trusted source summaries and recent runs                                |
| `POST /v1/sources/:id/runs`                | Queue ingestion; bearer token, empty JSON object, optional `Idempotency-Key` |
| `GET /v1/runs`, `GET /v1/runs/:id`         | List runs or inspect attempts/page results                                   |
| `GET /v1/products`, `GET /v1/products/:id` | List products or inspect variants/current offers                             |
| `GET /v1/variants/:id/history`             | Read offer history                                                           |

Runs, products, and history support `limit` (1–100) and endpoint-specific opaque cursors; sources are a bounded configuration list. Products filter by source/availability, runs by source/status, and history by observation time. Errors use `code` and `requestId`. A conflicting active source run returns 409; an idempotency-key replay can return the existing run.

## Security boundaries

Source configuration is trusted and read-only from the API. Clients cannot submit fetch URLs. HTTP enforces origin/path boundaries, validates every redirect and DNS destination, and pins the checked connection address. Public-policy sources require HTTPS and reject private/reserved addresses.

Untrusted HTML and JSON-LD are bounded before extraction; response sizes, traversal, strings, pagination, timeouts, and browser resources have limits. Extracted data is validated before parameterized SQL persistence. Logs redact authorization/cookies and avoid raw HTML and source snapshots.

Manual triggers require a bearer token and permit 10 requests/minute per client IP; the general API limit is 120/minute. These in-memory limits belong to one API process and reset on restart.

Compose publishes only the API on localhost:3000. The browser runs separately with the Chromium sandbox, on fixture/control networks without database or API network membership. Internal bridges remove host gateways. These controls were tested in the local Compose environment; they do not establish safety for arbitrary public browser workloads. See [source policy](docs/source-policy.md) and [security review](docs/security-review.md).

## Repository structure

```text
src/entrypoints/           API, worker, migration, and fixture processes
src/config/                Environment and trusted source validation
src/modules/api/           REST routes and pagination
src/modules/jobs/          Run creation and UTC scheduling
src/modules/ingestion/     Pipeline orchestration and attempt lifecycle
src/modules/network/       Controlled HTTP, DNS policy, pacing
src/modules/extraction/    JSON-LD, DOM, bounded HTML, browser extraction
src/modules/normalization/  Validated product/offer model
src/modules/catalog/       Transactional catalog/history persistence
src/shared/                Database, logging, errors, runtime grants
config/                    Demonstration source configuration
migrations/                PostgreSQL application schema
tests/                    Unit, PostgreSQL/API integration, browser fixtures/tests
docker/                   Browser sandbox/server and PostgreSQL bootstrap
docs/                     Architecture, policy, and stage evidence
.github/workflows/         CI definition
```

See [architecture](docs/architecture.md) for data flow and design decisions.

## Configuration and host development

`config/sources.json` defines trusted sources; `FIXTURE_ORIGIN` replaces fixture origins at startup. `SOURCE_CONFIG_PATH` selects another operator-controlled file. Restart processes after configuration changes; API configuration editing is intentionally absent. Bundled sources schedule every six hours in UTC.

| Variable                | Use                                             |
| ----------------------- | ----------------------------------------------- |
| `DATABASE_URL`          | PostgreSQL connection                           |
| `PORT`                  | API listener, default 3000                      |
| `FIXTURE_ORIGIN`        | Owned fixture origin                            |
| `BROWSER_ENDPOINT`      | Playwright server; empty selects local Chromium |
| `API_TOKEN`             | Manual-trigger bearer token, 16–256 characters  |
| `LOG_LEVEL`             | Structured log level                            |
| `SOURCE_CONFIG_PATH`    | Optional source-file override                   |
| `RUNTIME_DATABASE_ROLE` | Migration-only runtime grants in Compose        |

Compose supplies its own database URL, fixture origin, browser endpoint, and API port; it reads `API_TOKEN` from the environment/`.env`. Editing other values in `.env` alone does not override Compose's explicit settings. The example host database URL expects a separate PostgreSQL development database on port 5544; Compose does not publish PostgreSQL.

For an existing Compose volume created before the runtime-role security fix, bootstrap the new role once without deleting its data:

```sh
docker compose down
docker compose build
docker compose up -d --wait postgres
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U ingestion -d ingestion -f /docker-entrypoint-initdb.d/init-runtime.sql
docker compose up -d --wait
```

Use this upgrade sequence only for an old volume that lacks `ingestion_runtime`; fresh volumes initialize it automatically. The migration service then applies the runtime grants and Graphile policies. This upgrade was reviewed but not tested against an archived pre-security volume.

For host development, supply environment variables from `.env` using Node/tsx environment-file support:

```sh
node --env-file=.env --import tsx src/entrypoints/migrate.ts
node --env-file=.env --import tsx src/entrypoints/fixtures.ts
node --env-file=.env --import tsx src/entrypoints/worker.ts
node --env-file=.env --import tsx src/entrypoints/api.ts
```

Run long-lived entry points in separate terminals. Host browser extraction requires the Chromium installation described below. This optional host-only path was not independently validated end to end; the tested new-developer workflow uses Compose.

## Testing and validation

```sh
npm run format:check
npm run lint
npm run typecheck
npm test
TEST_DATABASE_URL=postgresql://ingestion:testing@localhost:5544/ingestion_test npm run test:integration
npm run test:browser
npm run build
docker compose config --quiet
docker compose build
```

Install host Chromium with `npx playwright install chromium` before browser/integration tests. On Linux, use `npx playwright install --with-deps chromium` when system libraries are missing. OpenSSL CLI is required for the local TLS regression.

To provide the disposable test database expected by the commands above (port 5544 must be free):

```sh
docker run -d --name ingestion-tests -e POSTGRES_USER=ingestion -e POSTGRES_PASSWORD=testing -e POSTGRES_DB=ingestion_test -p 127.0.0.1:5544:5432 postgres:17-bookworm
docker exec ingestion-tests pg_isready -U ingestion -d ingestion_test
```

Wait for `pg_isready` to report accepting connections before running integration tests. Compose's PostgreSQL is not host-published and does not substitute for this test database. After testing, remove only this disposable container and its anonymous data volume:

```sh
docker rm -f -v ingestion-tests
```

The example `.env` host-development URL instead names `ingestion` with the development password. Supply a separate PostgreSQL 17 development database matching it when using host entry points; it is not the test database above. `.env` affects host commands; Compose supplies its own database URL, fixture origin, browser endpoint, and API port. Compose reads `API_TOKEN` from the environment/`.env`.

Integration tests require a dedicated disposable database whose name ends in `_test`. They migrate it and clear application/queue records between cases. Never point them at a development or production database. Integration tests also include the full Playwright ingestion path. All extraction tests use local fixtures; no public scraping occurs in CI.

The automated demonstration covers initial ingestion, unchanged rerun, price changes, availability changes, return to an earlier state, transient retry, replay, page resumption, and browser fallback. Fixture state mutation exists only as an in-process test helper; there is no HTTP mutation endpoint.

The validated suite contains **65 tests: 33 unit, 22 PostgreSQL/API integration, and 10 Playwright/browser**. Unit tests cover normalization, extraction, configuration, and URL policy. Integration tests use real PostgreSQL and Fastify, covering persistence/history, jobs, API behavior, retry/replay, and security/resource bounds. Browser tests exercise controlled rendering and browser-specific restrictions.

Local validation also exercised clean Compose startup, real HTTP ingestion, history changes/deduplication, retries, authorization, pagination, and restart persistence. GitHub Actions has been reviewed statically; **no GitHub-hosted run is claimed**. Counts and discovered/fixed defects are recorded in [manual testing](docs/manual-testing.md), [security review](docs/security-review.md), and [final validation](docs/validation.md), with each report preserving its stage-specific evidence.

## V1 limits

One worker instance runs at most two jobs concurrently, with one active run per source and one browser extraction at a time. Scheduling is UTC-only. Browser extraction is intentionally limited to controlled fixtures; permitted public HTTP sources require an explicit Compose worker-network change and operator permission review.

Normalization supports USD/EUR/GBP, dot-decimal exact prices, and explicit availability mappings. Missing listings do not imply out of stock; stale current offers retain their last-observed timestamps. Broad locale handling, interactive variant selection, cross-source matching, retention jobs, and user accounts are deferred.

API rate limits are single-process. Production ingress/TLS/deployment and remote GitHub CI have not been validated. A local pg warning about queued queries remains with installed pg 8 operation passing; future pg 9 compatibility is unverified. No frontend, Redis, ORM, arbitrary crawling, or bypass/evasion mechanisms are included.
