# Architecture

## Processes and module boundaries

V1 is a modular monolith: API and worker have separate entry points but share TypeScript modules, configuration, and PostgreSQL. Keeping the queue in PostgreSQL avoids a second datastore while retaining durable background work.

| Process                       | Responsibility                                                            |
| ----------------------------- | ------------------------------------------------------------------------- |
| `src/entrypoints/api.ts`      | Fastify REST API, Swagger, trigger authorization, catalog/run reads       |
| `src/entrypoints/worker.ts`   | Graphile execution, UTC scheduler, ingestion runner, single-instance lock |
| `src/entrypoints/migrate.ts`  | Application/Graphile migrations and runtime-role grants                   |
| `src/entrypoints/fixtures.ts` | Owned deterministic HTML/JavaScript demonstration pages                   |
| Separate Playwright server    | Sandboxed Chromium for explicitly enabled fixture rendering               |

`config` validates operator input. `jobs` owns run creation/scheduling; `ingestion` coordinates attempts/pages. `network` owns fetch policy and pacing; `extraction` yields candidates; `normalization` validates offers; `catalog` owns transactional persistence. `api` reads persisted state and queues work; it does not scrape inside HTTP handlers. `shared` contains database, logging, and error utilities.

## Boundaries and flow

Both API and worker startup initialize the trusted source registry, so API triggers can queue before worker startup. The API enforces bounded in-memory per-IP request/trigger rates, validates requests and uses SQL for catalog/run queries. Manual triggers create a run and enqueue Graphile work in one PostgreSQL transaction. The worker schedules UTC occurrences and executes ingestion. Source configuration is developer-controlled JSON validated with TypeBox/Ajv; each run carries the exact configuration snapshot/hash.

Extraction follows controlled HTTP → JSON-LD → DOM fallback → optional fixture-only browser rendering → normalization → persistence. JSON-LD fields take precedence; invalid/missing fields can use matching DOM candidates. Identity joins use source listing IDs, never array position. Products are source-specific, with a default variant or source-provided JSON-LD offer SKU. Only exact offer prices are supported, not aggregate ranges.

## Ingestion lifecycle

1. A valid manual trigger or UTC schedule occurrence creates a run and Graphile job atomically, recording the configuration snapshot/hash. A unique active-source constraint prevents overlap.
2. Graphile executes the queued attempt. The runner establishes its deadline and loads completed page results for resumption.
3. Each configured page is fetched through the controlled HTTP client. JSON-LD candidates take precedence and matching DOM candidates supply missing/invalid fields. If no valid offers remain or candidates were rejected, and fixture browser extraction is enabled, Playwright renders the page and the rendered HTML goes through extraction/normalization again.
4. A page transaction persists valid offers and its result. Validated next links are followed within page/item/deadline limits; repeated URLs are bounded.
5. Expected transient failures persist attempt error/backoff state and enqueue a future attempt. Terminal state is `succeeded`, `partial`, or `failed`; partial means useful work committed despite rejected/incomplete data. Run, attempt, and page summaries are available through the API.

HTTP denial or policy violations do not activate browser fallback. Browser rendering is an extraction capability for owned JavaScript fixtures, not an access workaround.

## Persistence

The schema separates `sources`, `ingestion_runs`, `ingestion_attempts`, and `ingestion_page_results` from `products`, `variants`, `offer_current`, and append-only `offer_history`. Graphile owns its queue schema. API detail reads expose current variant offers and history separately.

Products and variants use source keys with unique constraints. Money uses numeric(20,6), serialized as strings. A page transaction locks its run, upserts catalog records, compares current offer state, inserts initial/change history, updates freshness, and commits the page result/counters. Each SQL write receives a timeout capped by the remaining run budget; an expired page rolls back. Replayed pages are no-ops. Equal price/currency/availability tuples do not create history; returning to an earlier tuple does.

Invalid records are rejected without erasing prior state. Availability must be explicitly recognized. Missing listings do not imply out of stock. Current state can remain stale after failures; its observation timestamp remains visible.

## Durable jobs

Graphile uses per-source named queues and global concurrency two. A database partial unique index prevents active source overlap. Manual idempotency keys and schedule occurrence uniqueness prevent duplicate enqueue. The worker holds a PostgreSQL advisory lock to enforce one V1 instance.

Expected transient failures schedule a new durable attempt with exponential jitter and Retry-After handling; workers do not sleep during backoff. There are at most four expected attempts and a ten-minute run deadline. Graphile permits three infrastructure attempts per queued task. Unexpected exhausted infrastructure work is finalized by deadline reconciliation on the scheduler tick. Graphile crash-lock recovery can take longer than normal retry delays; V1 does not promise immediate crash recovery.

Page resumption follows saved pagination links and skips completed pages. Terminal statuses are succeeded, partial, or failed. Nonretryable failures stop the run; previously committed pages remain visible. Scheduling uses the latest UTC occurrence and queues at most one catch-up occurrence per source after downtime. The scheduler ticks once per minute.

## Network and browser

HTTP permits configured origins and path boundaries, validates DNS answers, pins the selected address into the actual connection, and validates each redirect independently. Private/reserved addresses are forbidden for public-policy sources. Fixture policy is restricted to explicit local fixture hosts. Requests use identity encoding; unexpected compression is rejected rather than decompressed. Response bytes, time, pages, candidates, strings, and JSON-LD traversal are bounded. Text must be valid UTF-8; unsupported charsets are rejected. A streaming tokenizer limits HTML depth, nodes/events and attributes before DOM construction. Product/variant identity merging uses serialized tuples, and malformed Unicode/NUL values are rejected.

Browser requests are intercepted and fulfilled from the same controlled HTTP client. Request methods/types, count, total downloaded bytes, origin/path, and time are bounded. Service workers, WebSockets, popups, and downloads are blocked. Local launch uses the Chromium sandbox; Compose runs a separate sandboxed Playwright server on a fixture network plus a dedicated internal control network shared with the worker. The API has a separate ingress network so its localhost port remains publishable. Internal bridges use isolated gateway mode; actual native WebRTC and direct container probes are recorded in the security review. The browser cannot reach the API/database network in the tested Compose environment. This is a practical V1 boundary, not a claim that arbitrary untrusted public browser workloads are supported.

## Operations

Pino logs use stable error codes and run/source/attempt identifiers without raw HTML or configuration snapshots. Run, attempt, and bounded page summaries persist in PostgreSQL. API readiness checks application and queue schemas. Compose health checks probe API readiness, fixture liveness, the browser listener, PostgreSQL readiness, and the worker advisory lock. The worker health probe is an ownership/startup check, not a task-progress monitor. Run detail reads use one read-only repeatable-read transaction to keep run, attempt, and page summaries consistent during transitions. API readiness is independent of worker availability. PostgreSQL bootstrap is packaged into its image; the one-shot migration process uses the owner role and grants operational access to a separate non-superuser API/worker role, including Graphile service-role RLS policies. There is no monitoring platform or dashboard.

## Initial limitations

Normalization supports USD/EUR/GBP with dot-decimal prices and explicit availability mappings. Selector configuration supports basic fields; DOM variant interaction, locale-general price parsing, and broad JSON-LD semantics are deferred. No automatic missing-listing deletions, data retention job, migrations rollback CI, public-source permission automation, or user accounts are included. Public HTTP policy exists and is covered through local controlled security tests; no public source is bundled.

Manual testing and security review are recorded as stage-specific evidence. See [final validation](validation.md) for current checks and limitations; these reports preserve their historical evidence and tested scope.
