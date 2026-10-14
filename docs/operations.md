# Operations

Run commands from the repository root. Node.js 24 LTS is recommended (supported >=22.19); Docker Engine 28+ with Compose and a running daemon are required. The default API uses localhost:3000. Before startup, inspect existing resources and ensure the port is free. Remove unintended inherited Compose selectors/override settings; use the [isolated owner workflow](verification/manual-testing.md#reproducible-workflow-reference) when another application stack must remain untouched.

## Configuration

Copy `.env.example` to `.env` only for initial setup. The bundled credentials are local demonstration values, not deployment secrets. Never publish `.env`, authorization headers, or resolved credential-bearing Compose configuration.

| Variable                | Meaning                                                         |
| ----------------------- | --------------------------------------------------------------- |
| `DATABASE_URL`          | Host PostgreSQL connection; required by application/migrations  |
| `PORT`                  | Host API listener; default 3000                                 |
| `FIXTURE_ORIGIN`        | Owned fixture origin; default localhost:8080 for host processes |
| `BROWSER_ENDPOINT`      | Playwright server connection; empty selects local Chromium      |
| `API_TOKEN`             | Manual-trigger bearer token, 16–256 characters                  |
| `LOG_LEVEL`             | Structured logging level                                        |
| `SOURCE_CONFIG_PATH`    | Operator-controlled source JSON file override                   |
| `RUNTIME_DATABASE_ROLE` | Migration-only runtime grants in Compose                        |

Compose supplies explicit database/network URLs and the API port; it reads `API_TOKEN` from the environment/`.env`. Editing other `.env` values alone does not override those Compose settings. `config/sources.json` defines trusted read-only sources. Restart processes after source changes; bundled schedules run every six hours in UTC. Configuration permissions and URL rules are described in [source policy](source-policy.md).

## Startup, migrations, and health

```sh
npm ci
if [ ! -e .env ] && [ ! -L .env ]; then cp -n .env.example .env; fi
docker compose up --build -d --wait
docker compose ps -a
```

The guarded copy preserves an existing `.env`, including a symlink. Compose builds PostgreSQL bootstrap SQL into its image. Fresh volumes initialize the runtime role; the one-shot migrator installs application/Graphile schemas and grants runtime access. Migrate waits for healthy PostgreSQL; API/worker wait for successful migrations, and worker also waits for healthy fixtures/browser.

Expect five running/healthy services and migrate exited 0. `/health/live` checks API liveness; `/health/ready` checks database/schema readiness. Worker health checks advisory-lock ownership, not job progress. Inspect run state/history to assess actual ingestion.

```sh
curl --fail-with-body -sS http://127.0.0.1:3000/health/ready
docker compose logs --tail 200 migrate api worker browser
```

Logs and `ps -a` may contain operational details; inspect them privately before sharing. Readiness does not prove the worker is available. A successful HTTP 202 means queued work, not completed ingestion.

## Supported restart

For project `web-data-ingestion-engine` using the repository's `compose.yaml`:

```sh
./scripts/stack-restart.sh
```

The script resolves its repository directory, validates the selected configuration, stops services, then runs `up -d --wait`. It independently requires migrate exited 0 and every configured long-running service running/healthy. Exit 0 means those checks passed; failures return nonzero. It causes downtime, preserves volumes, does not rebuild images, and does not automatically retry migrations.

**Native whole-stack `docker compose restart` remains unsupported.** It can restart the one-shot migrator without startup dependency gates; the observed failure was `getaddrinfo EAI_AGAIN postgres`. Recovery succeeded with `up -d --wait`, but the underlying native restart behavior and DNS timing cause remain unfixed.

The script defaults to an explicit project/file and disables automatic override discovery. Different projects or file lists require exactly `INGESTION_STACK_ALLOW_ALTERNATE_TARGET=1`, scoped to one invocation. This acknowledges that the selected stack may be stopped; it does not establish that its data is disposable or configuration safe.

```sh
# Set these to a verified isolated project and distinct readable absolute YAML paths.
COMPOSE_PROJECT_NAME="$ISOLATED_PROJECT" \
COMPOSE_FILE="$ABSOLUTE_COMPOSE_FILE:$ABSOLUTE_OVERRIDE_FILE" \
INGESTION_STACK_ALLOW_ALTERNATE_TARGET=1 \
bash scripts/stack-restart.sh
```

Invalid names, relative/missing/duplicate files, unsupported `COMPOSE_*` controls, or Compose selectors in `.env` are rejected. Preflight requires all five mandatory gates: migrate → healthy PostgreSQL; API/worker → successful migrate; worker → healthy fixture-server/browser. Missing, weakened, or optional gates fail before stop. V1 requires one container per service, health checks on long-running services, one-shot migrate, and no profiled services. The operator remains responsible for Docker context and trusted files. The script prints effective identity/paths but suppresses raw command output to reduce credential exposure.

## Recovery and upgrades

On failure, services may be stopped or partially started. Inspect `ps -a` and migrator/service logs using the **same project/file selection**, correct the cause, and rerun the supported workflow. Do not delete the database volume to recover. With a dynamic port, rediscover it after restart using the same selection's `port api 3000`; owner testing observed port reassignment and recovered health by updating the URL.

For code/image upgrades, stop the selected stack before `up --build -d --wait`; the restart script does not request a rebuild. Plain `docker compose down` retains the named PostgreSQL volume. `down --volumes` deletes data: use it only after confirming a disposable project's ownership, with explicit project/file arguments. Never use global prune as project cleanup.

Fresh volumes need no extra step. The following role-bootstrap procedure applies only to an old volume lacking `ingestion_runtime`. **It has not been independently validated against an archived volume. Before using it with valuable data, require a verified backup with a checked restore procedure, confirm the Docker context/project and exact database volume, and obtain separate operator review of the commands and target. Stop if any prerequisite is unmet.** These commands assume the intended default project, repository Compose file, and no inherited target/override settings:

```sh
docker compose down
docker compose build
docker compose up -d --wait postgres
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U ingestion -d ingestion -f /docker-entrypoint-initdb.d/init-runtime.sql
docker compose up -d --wait
```

Use only for the intended old default-project volume lacking the role. Migration then reapplies runtime grants and Graphile policies without blind volume deletion.

## Database choices and host development

Compose's application database is `ingestion`, with a persistent project-scoped volume and no published database port. The host test database is a separate disposable `ingestion_test` on localhost:5544. Tests migrate/clear it; never point them at application or production data. [Testing](testing.md) provides the isolated CI environment and host database commands.

The example host `.env` URL instead expects a separate PostgreSQL development database named `ingestion` with the development password on port 5544. It is not the disposable test database. For optional host development, install Chromium as documented in testing, provide that database, then run migrations and long-lived processes in separate terminals:

```sh
node --env-file=.env --import tsx src/entrypoints/migrate.ts
node --env-file=.env --import tsx src/entrypoints/fixtures.ts
node --env-file=.env --import tsx src/entrypoints/worker.ts
node --env-file=.env --import tsx src/entrypoints/api.ts
```

The complete host-only path was not independently validated end to end; Compose is the tested demonstration path. External deployment requires new secrets, trusted ingress/TLS, network review, and environment-specific validation.
