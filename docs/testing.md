# Testing

All suites use owned fixtures rather than public scraping. Run from the repository root after `npm ci`, using Node.js 24 LTS (supported >=22.19). OpenSSL CLI is required by the local TLS unit regression. The test counts below describe a verified baseline, not a coverage percentage or guarantee for every environment.

## Host checks and isolated CI tests

```sh
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
bash -n scripts/stack-restart.sh scripts/ci-run.sh scripts/ci-tests.sh
git diff --check
bash scripts/ci-run.sh /tmp/ingestion-ci-test-logs
```

The CI runner requires a Linux Docker engine with Compose, isolated internal bridge support, and readable Linux process sandbox evidence. It generates a unique disposable project with PostgreSQL and a digest-pinned Playwright image, no published ports, and an internal network. Non-root tests run with all outer capabilities dropped, no-new-privileges, and the CI-only seccomp policy. Both direct and server launch paths must provide namespace/seccomp evidence before integration/browser tests start; inconclusive evidence fails.

Reports require all 22 integration and 10 browser cases to pass with no failed/pending/todo cases. Logs/reports go to the supplied directory. Ordinary exit cleanup removes the generated containers, network, volume, and project image; SIGKILL, daemon failure, or runner loss may interrupt cleanup. Inspect the printed project identity and ownership before removing leftovers. No global prune is used. Host unit/static checks are separate from this runner.

Additional configuration and image-build checks use `docker compose config --quiet` and `docker compose build`. They do not prove runtime startup.

## Host integration/browser alternative

Host Chromium is needed for **both** integration and browser suites:

```sh
npx playwright install chromium
```

On Linux with missing system libraries, use `npx playwright install --with-deps chromium`. Host browsers do not inherit Compose network isolation; prefer the isolated runner for hostile fixtures.

Before provisioning PostgreSQL, inspect existing containers/ports, ensure `ingestion-tests` is absent, and verify localhost:5544 is free. Stop on a conflict; do not reuse an existing application database. Only after those checks:

```sh
docker run -d --name ingestion-tests -e POSTGRES_USER=ingestion -e POSTGRES_PASSWORD=testing -e POSTGRES_DB=ingestion_test -p 127.0.0.1:5544:5432 postgres:17-bookworm
docker exec ingestion-tests pg_isready -U ingestion -d ingestion_test
```

Wait until `pg_isready` reports accepting connections, then:

```sh
TEST_DATABASE_URL=postgresql://ingestion:testing@localhost:5544/ingestion_test npm run test:integration
npm run test:browser
```

Integration tests require a dedicated database name ending in `_test`; they apply migrations and clear application/queue records between cases. The Compose application database and example host-development database do not substitute for this disposable database. After checking that the container is the one created for this test, remove only it and its anonymous volume:

```sh
docker rm -f -v ingestion-tests
```

## What the suites establish

| Suite                      | Verified count | Main behavior exercised                                                                                                                                                                                                                                                    |
| -------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit                       | 136            | Extraction, normalization, source/URL policy, TLS/DNS/resource bounds, fixture health, setup-failure cleanup, CI sandbox evidence rejection and failure propagation. Includes 86 mocked restart-script cases; these do not mutate Docker or prove real lifecycle behavior. |
| PostgreSQL/API integration | 22             | Real persistence, history deduplication/changes, rollback/deadlines, idempotency/overlap, retry timing, scheduling/Graphile delivery, page resumption, API/OpenAPI, runtime privileges, and the full browser ingestion pipeline.                                           |
| Browser                    | 10             | Fixture rendering, local/server launch use, policy restrictions, time/queue/byte budgets, WebSocket/popup rejection, and fresh contexts.                                                                                                                                   |

Hosted [Development checks run 38444687594](https://github.com/Warw0lfLabs/web-data-ingestion-engine/actions/runs/38444687594) passed all 168 tests at `0a1b314afda8643418987a16f4035112be2e79e2`. Both sandbox paths passed on Ubuntu/amd64. Local Linux/arm64 testing also passed. Pipelines use explicit Bash pipefail and regression probes verify nonzero propagation. The earlier false-green run had eight failed tests despite a successful workflow conclusion; see the [historical investigation](verification/validation.md#false-green-ci-investigation--13-october-2026). Successful artifact upload on failure is not established by a successful run that skips that branch.

## Manual demonstration

1. Follow README startup, verify five healthy services and migrator exit 0, then check liveness/readiness, Swagger, and the three sources. Use the [isolated workflow](verification/manual-testing.md#reproducible-workflow-reference) if existing owner data must remain untouched.
2. Trigger `structured`, `dom`, and `javascript` using README's token-safe example. Save returned run IDs; HTTP 202 means accepted, not finished. Scheduler catch-up may already populate the catalog or hold a source active. On HTTP 409, inspect its active run and wait before triggering again.
3. Poll `/v1/runs/{id}` within a bounded deadline until `succeeded`, `partial`, or `failed`; inspect errors/attempts if it does not succeed. Expect one accepted record and page extractor `jsonld`, `dom`, or `browser`. Do not claim intermediate states that polling did not observe.
4. Inspect products, product details, current variant offers, and each history endpoint. Initial fixtures are 19.99/29.50/49.00 USD, in stock. Save history rows, trigger a new unchanged structured run, poll completion, then compare complete history rows/IDs: changed=0 and no extra history are expected; freshness timestamps can advance.
5. Capture the catalog/history SQL snapshot from the evidence report, run the supported restart for the same project, and compare selected identities/current state and complete history before/after. Rediscover any dynamic API port before health requests. Clean up only verified disposable resources; preserve normal application data.

Price/availability mutation and transient failures are tested through in-process fixture helpers and recorded operator workflows. There is no public HTTP fixture-mutation endpoint; the simple manual demonstration does not reproduce every automated case.

## Owner evidence and acceptance

Independent owner smoke testing on 13 October 2026 used a clean checkout at `e59964b21b77312c3fa6c6d22bd0172d05f8287b`. Three manual runs succeeded on a catalog already populated by scheduling, with unchanged offers and one original history row per variant. Restart snapshots matched byte-for-byte. Initial post-restart health requests returned HTTP 000 because the loopback port changed; both health endpoints passed after rediscovery. Disposable resources were removed, and the original stack remained healthy with its volume present; exact original-data equality was not established.

The additional post-history structured rerun was not performed in the 13 October session; it **passed on 25 October 2026** at the same tested checkout. Before/after history contained the identical single record without duplication. The initial POST omitted the required JSON body and returned 400; the corrected `{}` request returned 202 and the manual JSON-LD run succeeded with changed=0. Owner-authorized disposable cleanup followed; no independent original-application database equality is claimed.

**Final owner acceptance: ACCEPT, 2026-10-25**, for V1 demonstration and portfolio readiness with documented limitations. The architecture/operations walkthrough and walkthrough delivery acknowledgment are **SKIPPED BY OWNER**, not delivered or completed. V1 Definition of Done is complete within that accepted scope and those waivers; production deployment remains unvalidated. Full evidence and the dated decision are in the [owner record](verification/manual-testing.md#final-owner-decision--25-october-2026).
