# Web Data Ingestion Engine

A TypeScript backend that collects permitted product listings, normalizes them into a PostgreSQL catalog, and exposes current offers, price/availability history, and ingestion jobs through a REST API. It demonstrates the work behind repeatable catalog imports: extracting inconsistent data, managing background jobs, and keeping useful history without duplicate observations.

V1 uses three owned demonstration sources: JSON-LD, static HTML, and JavaScript-rendered listings. These make extraction and failure scenarios reproducible without depending on a public website. The project is a portfolio demonstration with production-style engineering practices; production deployment has not been validated.

## Capabilities

- Trusted source configuration with origin/path rules, selectors, UTC schedules, and resource limits.
- HTTP extraction with JSON-LD precedence, matching DOM fallbacks, and explicitly enabled fixture-only Playwright rendering.
- Products, variants, current offers, and change-only price/currency/availability history.
- Durable manual and scheduled jobs with overlap prevention, idempotency, page resumption, and bounded retries.
- Validated REST endpoints, cursor pagination, Swagger documentation, structured logs, and health checks.
- Docker environments and automated unit, real PostgreSQL/API integration, and browser tests.

The stack is Node.js/TypeScript, Fastify, PostgreSQL with `pg` and node-pg-migrate, Graphile Worker, Cheerio, Playwright, TypeBox/Ajv, Pino, Vitest, Docker Compose, and GitHub Actions. API and worker are separate processes in a modular monolith; PostgreSQL also holds the job queue.

## Run locally

Use Node.js 24 LTS (recommended; supported >=22.19), Docker Engine 28+ with Compose, and a running Docker daemon. Port 3000 must be free. Run from the repository root in a fresh checkout, with no inherited Compose target/override settings. Inspect existing Docker resources first if other projects are running. Preserve an existing `.env`; copy the example only during initial setup.

```sh
npm ci
if [ ! -e .env ] && [ ! -L .env ]; then cp -n .env.example .env; fi
docker compose up --build -d --wait
docker compose ps -a
```

Expect five healthy long-running services—PostgreSQL, API, worker, fixture server, and browser—and `migrate` exited with code 0. Compose packages database bootstrap SQL into its image and runs application/Graphile migrations automatically. Host PostgreSQL and Chromium installations are unnecessary for this workflow. Only the API is published, on loopback port 3000.

```sh
curl --fail-with-body -sS http://127.0.0.1:3000/health/live
curl --fail-with-body -sS http://127.0.0.1:3000/health/ready
curl --fail-with-body -sS http://127.0.0.1:3000/v1/sources
```

Open [Swagger UI](http://127.0.0.1:3000/docs); [OpenAPI JSON](http://127.0.0.1:3000/docs/json) is also available. The example token/passwords are demonstration credentials. Replace them and review ingress/security before any external exposure. Read endpoints and Swagger are intentionally unauthenticated.

## Trigger, poll, inspect

This example reads the trigger token from `.env` without printing it:

```sh
node --env-file=.env --input-type=module <<'JS'
const response = await fetch('http://127.0.0.1:3000/v1/sources/structured/runs', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authorization: `Bearer ${process.env.API_TOKEN}`,
  },
  body: '{}',
});
console.log(response.status, await response.text());
JS
```

A successful trigger returns HTTP 202 with `id` and `reused`. Copy the ID into Swagger's `GET /v1/runs/{id}` operation, or poll with curl:

```sh
RUN_ID=replace-with-returned-run-id
curl --fail-with-body -sS "http://127.0.0.1:3000/v1/runs/$RUN_ID"
```

Repeat within a bounded deadline until `succeeded`, `partial`, or `failed`. `queued`, `running`, and `retrying` are nonterminal; a fast job may finish before the first poll. The scheduler can populate data before manual triggers. If a source already has an active run, HTTP 409 means wait for that run before triggering again.

Inspect `/v1/products`, then `/v1/products/{id}` for variants/current offers and `/v1/variants/{id}/history` for changes. An unchanged observation refreshes timestamps without appending history. Repeat the trigger with `dom` and `javascript` to exercise the other strategies:

| Source     | Extraction                             | Initial offer       |
| ---------- | -------------------------------------- | ------------------- |
| structured | JSON-LD                                | 19.99 USD, in stock |
| dom        | CSS selectors                          | 29.50 USD, in stock |
| javascript | Enabled fixture-only browser rendering | 49.00 USD, in stock |

Sources are read-only through the API. Runs, products, and history support bounded cursor pagination; use `nextCursor` with the same filters. Swagger describes query parameters, bearer authorization, errors, and optional trigger idempotency keys.

## Engineering decisions

The API queues work rather than scraping inside requests. A run and its Graphile job are created transactionally; per-source queues and a database uniqueness constraint prevent overlapping source runs. One worker handles at most two jobs concurrently, with one browser extraction at a time.

The pipeline validates URLs and redirects, fetches bounded resources, extracts candidates, normalizes offers, and persists each page transactionally. Stable source keys preserve product/variant identities. Only a changed price/currency/availability tuple creates history; returning to a previous state creates a new change record. Completed pages are skipped on replay, while valid data from earlier pages remains visible if later work fails.

Browser rendering is an explicit extraction strategy for owned fixtures, never a response to authentication or anti-bot denial. A separate sandboxed browser service shares fixture/control networks without joining API/database networks. See [architecture](docs/architecture.md) and [security](docs/security.md) for the design and its boundaries.

## Restart and recovery

For the repository's default project:

```sh
./scripts/stack-restart.sh
```

This causes downtime, preserves the database volume, and checks migration exit 0 plus healthy services after ordered stop/start. It does not rebuild images. **Native whole-stack `docker compose restart` is unsupported** and can fail the one-shot migrator; its underlying behavior remains unfixed. Alternate projects/files require explicit acknowledgment. Read [operations](docs/operations.md) before upgrades, alternate targets, recovery, or cleanup. Never delete a database volume to resolve a startup error.

## Tests and verification

After `npm ci`, run host checks and the isolated CI test environment:

```sh
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
bash scripts/ci-run.sh /tmp/ingestion-ci-test-logs
```

The last command creates disposable PostgreSQL/test resources and verifies sandbox evidence before integration/browser tests. [Testing](docs/testing.md) covers prerequisites, cleanup limitations, host alternatives, and a manual demonstration.

Hosted [run 38444687594](https://github.com/Warw0lfLabs/web-data-ingestion-engine/actions/runs/38444687594) passed **136 unit, 22 integration, and 10 browser tests** at baseline `0a1b314afda8643418987a16f4035112be2e79e2`, including both Chromium sandbox paths on Ubuntu/amd64. These are baseline results, not a coverage percentage. An earlier false-green workflow was diagnosed and corrected with explicit failure propagation; its failures remain in the [evidence archive](docs/verification/README.md).

Independent owner smoke testing exercised three-source ingestion and restart persistence; the additional post-history structured rerun passed. **Final owner acceptance: ACCEPT, 2026-10-25.** V1 Definition of Done is complete within the accepted portfolio demonstration scope, with documented limitations and owner waivers. The architecture/operations walkthrough and its delivery acknowledgment are **SKIPPED BY OWNER**, not completed. See the [owner evidence](docs/testing.md#owner-evidence-and-acceptance).

## Scope and documentation

V1 supports USD/EUR/GBP dot-decimal prices, explicit availability mappings, UTC schedules, and trusted configured sources. Missing listings do not imply out of stock. Public-source browser scraping, arbitrary crawling, accounts, frontend, and distributed workers are outside scope. Public HTTP sources require permission review and an explicit worker-network change. Production ingress/TLS, full IPv6 isolation, archived-volume upgrades, and future pg 9 compatibility remain unverified.

Start with [operations](docs/operations.md), [testing](docs/testing.md), [architecture](docs/architecture.md), and [source policy](docs/source-policy.md). Detailed historical findings and execution evidence remain under [verification](docs/verification/README.md).
