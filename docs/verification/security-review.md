# Security review

This is a historical stage report: its test totals and environment describe that stage. Current implementation/checks are recorded in [final validation](validation.md); later corrections do not rewrite the earlier evidence.

Review date: 2026-10-06. Scope: the implemented V1 application, Compose environment, lockfile, CI configuration, and security tests. The results below describe this security review; subsequent validation is documented separately.

## Threat model and environment

The API client and permitted source content are untrusted. A content author may supply malicious HTML, JavaScript, JSON-LD, identifiers, prices, or pagination links. An API client may send malformed requests or request bursts. Source files, deployment environment, migration credentials, and the Docker administrator are trusted. The service is not a tenant platform. Reads and Swagger documentation are intentionally public; ingestion triggers require an operator bearer token. No arbitrary URL submission is supported.

Testing used macOS/Colima, host Node.js 22.23.2, Docker Engine 29.5.2 (Linux/aarch64), Compose 5.5.1, PostgreSQL 17, application Node.js 24, and Chromium/Playwright 1.63.0. The disposable Compose project was `ingestion-security-test`, with API at `127.0.0.1:3000`. Automated PostgreSQL tests used the existing disposable `ingestion_test` database on port 5544. Browser unit/integration tests used local fixtures and host Chromium. TLS tests generated temporary certificates using OpenSSL.

## Methodology

Read the actual HTTP client, source validation, browser extractor, static extractors, normalization, persistence, jobs/scheduler, API, environment validation, migrations, container definitions, and CI. Followed data across trust boundaries instead of treating architecture documentation as proof. Checked dependency advisories, install scripts, example credentials, ignored configuration, and runtime logs.

Executed bounded requests against the real Compose API; polled job state; inspected PostgreSQL results and effective privileges; tested browser-container connectivity and native browser networking. Used injected DNS resolvers, a local HTTPS server, temporary certificates, deterministic hostile HTML, and a disposable UDP listener on the Docker VM. No public catalog, authentication bypass, proxy rotation, stealth mechanism, or cloud metadata endpoint was used. An external connection probe had no route; all extraction requests stayed local.

## Findings: discovered and remediated

No critical or high finding was identified. Seven medium findings and one low finding are recorded below. Severity reflects the local V1 threat model; the database-privilege finding describes impact after a separate application compromise, not a demonstrated compromise chain.

| ID    | Severity | Component             | Finding                                                                                                          | Status     |
| ----- | -------- | --------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------- |
| SR-01 | Medium   | Browser / Docker      | Native browser networking could reach the Docker host gateway                                                    | Remediated |
| SR-02 | Medium   | Database deployment   | API and worker used PostgreSQL superuser credentials                                                             | Remediated |
| SR-03 | Medium   | Extraction identity   | Delimiter-based keys conflated distinct product/variant pairs                                                    | Remediated |
| SR-04 | Medium   | Text validation       | NUL, unpaired surrogates, and lossy decoding could break or conflate identities                                  | Remediated |
| SR-05 | Medium   | API resource use      | No request or manual-trigger rate budget                                                                         | Remediated |
| SR-06 | Medium   | Persistence           | A page could commit after the run deadline                                                                       | Remediated |
| SR-07 | Medium   | HTML parsing          | Small but deeply nested markup exceeded the parsing time probe                                                   | Remediated |
| SR-08 | Low      | API validation/errors | Malformed client input became 500 errors; oversized bigint cursors reached SQL; unknown routes reflected queries | Remediated |

### SR-01: Docker host reachability

**Evidence before:** With every Playwright HTTP request aborted, a page created an `RTCPeerConnection` using the browser network's bridge address as a STUN server. A disposable Docker-host UDP listener received four 20-byte packets from the browser container. This demonstrated a native networking path outside Playwright routing. It did not demonstrate access to PostgreSQL, the API, the macOS host, or execution on the Docker host.

**Impact:** A malicious fixture script could contact/probe Docker-host UDP services through the bridge gateway. Request routing alone was not a complete network boundary.

**Fix:** All four internal Compose networks now use `com.docker.network.bridge.gateway_mode_ipv4: isolated`. The browser still shares fixture/control networks but not data/API ingress networks. No functionality was removed.

**Retest:** Docker inspection showed isolated mode and no IPAM gateway on the browser fixture network. Repeating the native STUN probe added zero packets to the listener's original four. Direct browser-container TCP probes reached `fixture-server:8080`, while database/API names failed resolution, their actual container IPs returned `ENETUNREACH`, and `8.8.8.8:443` returned `ENETUNREACH`. Chromium remained functional: the real JavaScript ingestion completed with `extractor=browser`.

**Regression:** Compose tests require isolated mode and the intended network separation. Browser tests cover out-of-policy subrequests, WebSockets, popups, fresh cookies, timeouts, and byte budgets. The native Docker networking probe was manually executed; the configuration test alone is not evidence of runtime isolation.

### SR-02: Runtime database superuser

**Evidence before:** Compose supplied the bootstrap PostgreSQL role to API, worker, and migrations. PostgreSQL's `POSTGRES_USER` bootstrap role is a superuser.

**Impact:** A separate application compromise would also gain database-administrator/server-side privileges. No SQL injection or application-compromise chain was found.

**Fix:** Compose bootstraps `ingestion_runtime` with no superuser, database-creation, role-creation, or replication privilege. Migrations retain the owner credential; runtime processes receive operational table/sequence/function access, no public-schema creation, and read-only migration tables. Graphile private tables retain RLS with policies specifically authorizing this service role; it has no global `BYPASSRLS` grant.

**Retest:** PostgreSQL returned `rolsuper=false`, `rolcreatedb=false`, `rolcreaterole=false`, schema `CREATE=false`, and migration `UPDATE=false`. HTTP-triggered JSON-LD, DOM, and browser runs all succeeded under this role. Integration tests execute real ingestion as a non-owner and assert denied schema/migration writes.

**Remediation defect caught:** Initial grants omitted Graphile's RLS policies. Real API calls returned 500 and Graphile logged RLS errors. Added explicit service policies, rebuilt, and repeated the HTTP workflow successfully. Earlier errors were retained in the diagnosis; recent post-fix logs had no such errors. Existing volumes require the role bootstrap before switching runtime credentials; see README.

### SR-03: Product/variant delimiter collision

**Evidence before:** JSON-LD pairs `(a:b, c)` and `(a, b:c)` yielded one offer because both became the key `a:b:c`.

**Impact:** Distinct products/variants could silently disappear or inherit another record's values before persistence.

**Fix:** Use a serialized identity tuple; invalid anonymous records get unique symbols rather than keys that can collide with real identifiers.

**Retest/regression:** Unit extraction now returns both offers. A PostgreSQL ingestion test persists both identities, three distinct products/variants/history rows including an SQL-looking identifier, and preserves parameterized SQL semantics.

### SR-04: Malformed Unicode and lossy decoding

**Evidence before:** Normalization accepted NUL and lone-surrogate identifiers. Read-only PostgreSQL probes returned error `22021` for a NUL parameter and equality `true` for two different lone-surrogate strings after UTF-8 replacement. HTTP decoding used replacement-based `Buffer.toString`, which similarly loses invalid-byte distinctions.

**Impact:** Malformed input could fail a whole page and consume infrastructure retries, or collapse distinct identifiers into one stored identity.

**Fix:** Reject NUL and unpaired surrogates in normalized strings and attribute keys/values. Validate fetched text with fatal UTF-8 decoding. Reject explicitly unsupported charsets; V1 supports UTF-8 text rather than silently interpreting other encodings.

**Retest/regression:** Unit tests reject malformed identifiers, invalid UTF-8 response bytes, and unsupported charsets. PostgreSQL ingestion rejects malformed records individually (`partial`, accepted 3, rejected 2, attempt 1), preserves valid multilingual/emoji text, and stores the valid records without a retry. Temporary TLS private keys exist only in test temporary directories and are removed by the tests.

### SR-05: API request budgets

**Evidence before:** All 130 sequential real HTTP catalog requests returned 200. No route-level rate budget existed. Overlap prevention bounded concurrent ingestion, but did not bound reads, failed trigger attempts, logs, or completed sequential triggers.

**Impact:** A reachable client could consume API/database/log resources repeatedly; a client holding the trigger token could continually create runs.

**Fix:** Fastify's in-memory limiter allows 120 requests per minute per client IP, with 10 manual-trigger requests per minute and a bounded 5,000-entry cache. Proxy headers are not trusted. No Redis or distributed machinery was added.

**Retest/regression:** The repeated real 130-request burst returned 120 successes and 10 structured 429 responses. API integration tests check the read budget and independently exhaust unauthorized trigger attempts. Limits reset on process restart and are not a distributed-DDoS defense.

### SR-06: Deadline enforcement during persistence

**Evidence before:** A real PostgreSQL test used a one-second run budget and a temporary trigger simulating 650 ms insert latency. Two offers committed and the run reported `succeeded` after its deadline. The regression failed before remediation. The trigger modeled database latency; it was not an attacker-controlled database object.

**Impact:** An allowed large page could continue many SQL operations after its deadline, retaining locks and worker capacity. A timer does not interrupt database statements by itself.

**Fix:** Each persistence statement checks remaining run time and receives a transaction-local timeout capped by that remainder and 15 seconds. Expiry becomes a structured error and rolls the entire page back. Check the deadline again before committing the page and before final success.

**Retest/regression:** The same probe now returns `failed / RUN_DEADLINE`; products and history are both empty. Previously committed pages still use the intended partial-result behavior. Connection/rollback/commit cleanup can add small overhead beyond a deadline; this is not a realtime guarantee.

### SR-07: Pathological HTML

**Evidence before:** A bounded subprocess with a 128 MB Node heap did not complete extraction of 50,000 nested `div` elements within five seconds and was terminated. The approximately 550 KB input was below the HTTP size limit. This establishes an excessive-work case, not proof that parsing would run forever.

**Impact:** Synchronous DOM parsing can occupy the single worker event loop despite asynchronous HTTP/run timers.

**Fix:** Before Cheerio/parse5 constructs a DOM, a streaming HTML tokenizer enforces 2 MiB text, depth 128, 20,000 structural/text/comment events, 100 attributes per element, and bounded tag/attribute names. A structural violation is terminal `HTML_LIMIT`. The parser dependency matches Cheerio's existing compatible version.

**Retest/regression:** The same nested input returned `HTML_LIMIT` in 1 ms in the direct retest. Unit tests cover excessive depth, comments/nodes, and attributes with bounded completion. Normal fixtures and the complete static/browser workflows remain supported. Docker memory/CPU limits remain a second boundary.

### SR-08: Client errors and cursor bounds

**Evidence before:** Actual HTTP requests containing broken JSON, oversized JSON, and XML returned 500. An unknown-route response copied a query-string sentinel into its message. A 19-digit history cursor could exceed signed PostgreSQL bigint range.

**Impact:** Client-controlled input caused unnecessary server-error/log paths; query reflection could propagate sensitive client-supplied URL contents. No application secret was disclosed by this probe.

**Fix:** Preserve framework 4xx statuses with static error codes; use a structured non-reflecting 404 handler; range-check history cursors before SQL; constrain source IDs/filters and timestamp lengths.

**Retest/regression:** Real HTTP returns 400 for malformed JSON, 413 for oversized bodies, 415 for unsupported content, and a static 404 without the query. Oversized history cursors, SQL-looking filters, NUL filters, invalid UUIDs, prototype-shaped queries, and invalid list limits returned 400. Unknown valid UUIDs returned 404. API tests exercise the parser/status and cursor cases.

## Additional tightened controls

- URLs are capped at 2,048 characters; nested percent encodings, encoded separators, and NUL paths are rejected. Source start URLs use the same policy as redirects/pagination. Encoded traversal was accepted by the former policy; exploitation against a multiply decoding upstream was not demonstrated. This is defensive path-boundary tightening, not a claimed internal-service exploit. Normal UTF-8 percent-encoded path segments remain supported. Malformed/oversized pagination is a structured rejection.
- Browser queue waiting, connection, navigation, and resource downloads share a timeout budget. Cumulative browser downloads are serialized and each receives only the remaining byte allowance, rather than each concurrent request spending a full allowance before the total check. A queued extraction expires and later extraction still succeeds; concurrent-resource tests exceed the shared budget and are rejected.
- A context-close race introduced while tightening the browser timer caused two unhandled rejections in the first test run. Memoized cleanup fixed it; subsequent browser runs had no unhandled errors.

## Explicitly reviewed areas without another finding

- **SSRF:** URL parsing canonicalizes alternate numeric hosts before exact origin matching. Rejects credentials, non-HTTP protocols, changed origins/ports, out-of-prefix paths and redirected destinations. Public policy rejects any non-public DNS answer, including mixed public/private answers. Tests cover private/reserved IPv4/IPv6, mapped IPv6, metadata/link-local ranges, numeric loopback forms, redirect loops, pacing, DNS timeouts, and connection pinning. Fixture exceptions are restricted to explicitly configured fixture hosts. Public-host DNS behavior was tested with injected resolvers, not a live rebinding domain.
- **TLS/proxies:** A local certificate trusted via a child process's `NODE_EXTRA_CA_CERTS` succeeded for its hostname using the pinned IP. The same IP with a different hostname was rejected. Invalid `HTTP_PROXY`/`HTTPS_PROXY` settings did not divert the successful fetch because it uses an explicit Undici agent. Production certificate checks were not disabled.
- **HTTP/resource bounds:** Unsupported compression is rejected, so compressed expansion is not performed. Streaming response size, redirects, HTTP/DNS time, pages, total items, retry attempts, and API page sizes are bounded. Existing tests verify byte rejection, unsupported compression, redirect limits, pagination, due-time retries, and replay. Browser requests are capped at 30; only allowed GET resource types are fetched through the controlled client.
- **Browser execution:** Fresh contexts, blocked service workers/download acceptance, blocked WebSockets, closed popups, and request interception are implemented. Browser is UID 1001, effective capabilities zero, seccomp mode 2; inspected Chromium processes lacked `--no-sandbox`. Routing and sandboxing are complementary to the separately tested Docker boundary, not substitutes for it.
- **Authorization:** Missing token, invalid token, Basic scheme, and wrong-case scheme returned 401; valid bearer tokens returned 202. Token comparison uses equal-length buffers and `timingSafeEqual`. Fetch normalizes trailing header whitespace, so a valid token followed by whitespace becomes a valid header rather than a demonstrated bypass. Only the protected POST route changes application state; source configuration stays read-only. Swagger declares bearer protection without embedding the token.
- **SQL/integrity:** User data uses parameters. The grant helper's role identifier is restricted and database-derived table identifiers are quoted. Transactions, unique constraints, source-row locks, offer locks, source job queues, and worker ownership protect the V1 concurrency model. Automated tests cover rollback, concurrent snapshots, overlap, idempotency, replay, unchanged history, actual price/availability changes, and recovery after transient failures. Real unchanged Compose reruns left exactly one history row per source.
- **Extraction:** JSON-LD parses data only; it does not resolve remote contexts or execute scripts. Script/block, size, traversal-depth/node and item limits are implemented. CSS selectors are bounded operator configuration. Prices/currencies/availability and normalized lengths/attribute counts are validated. Static extraction does not evaluate HTML JavaScript; JavaScript runs only in the explicitly enabled fixture browser environment.
- **Secrets/errors:** Repository/config/log searches found development/test examples, not a real credential/private-key disclosure. `.env` is ignored and excluded from the build context. API logs omit query strings and auth/cookie headers; API errors omit SQL/stack/raw HTML. Recent Compose logs contained zero matches for both supplied secret sentinels, the example bearer token, runtime password, or connection-string marker; zero unexpected-error/stack markers were found. Catalog URLs intentionally reveal fixture origins; do not configure credential-bearing URLs.
- **Supply chain/CI:** Lockfile v3 records npm integrity hashes. `npm audit --json` reported zero known advisories. Reviewed lifecycle entries were esbuild's binary installation and optional macOS fsevents; neither was treated as proof of safety. CI has read-only contents permission, commit-pinned actions, disposable example database credentials, no deployment/secrets, and local-fixture tests. Docker images use version tags; digest pinning and image/CVE scanning remain limitations. GitHub-hosted CI itself was not executed during this review.

## Execution evidence and regression checks

Major commands actually executed included:

```sh
docker compose -p ingestion-security-test up -d --build --wait
docker compose -p ingestion-security-test ps -a
docker network inspect ingestion-security-test_browser-fixtures
docker compose -p ingestion-security-test exec -T postgres psql -U ingestion -d ingestion
npm audit --json
npm run format:check
npm run lint
npm run typecheck
npm test
TEST_DATABASE_URL=postgresql://ingestion:testing@localhost:5544/ingestion_test npm run test:integration
npm run test:browser
npm run build
```

HTTP probe scripts issued actual requests, not Fastify injection, and polled real terminal states. Final successful Compose runs after the last rebuild were:

| Source     | Run ID                                 | Observed result                                      |
| ---------- | -------------------------------------- | ---------------------------------------------------- |
| Structured | `6b7ec452-414b-4a32-87db-3a925270bedd` | succeeded, attempt 1, accepted 1, jsonld, changed 0  |
| DOM        | `c7fa5deb-6b71-442c-a1f2-dae3a5b5ba57` | succeeded, attempt 1, accepted 1, dom, changed 0     |
| JavaScript | `b91adb61-474a-42ad-8c9a-4530a250d93d` | succeeded, attempt 1, accepted 1, browser, changed 0 |

The final check totals and cleanup status are recorded below after the final rerun. Initial tests ran in a restricted execution environment that prohibited local server binding (`EPERM`); rerunning with local networking enabled passed. Early type/lint failures in the fixes were corrected before the final check. The role/RLS and browser-cleanup failures above were genuine remediation issues, not hidden successes.

## Residual risks and accepted V1 limitations

- This review is not proof of absence of vulnerabilities. It did not include Chromium/kernel exploit research, a full IPv6 deployment, production TLS ingress, live public-source testing, or a container-image vulnerability scan. Docker networks here are IPv4-only; enabling IPv6 requires equivalent isolation and retesting.
- Native browser probes establish boundaries in the tested Docker VM. Host-side browser development tests have no Compose network isolation. Use Compose for hostile browser fixtures; do not run them on a sensitive host profile. The trusted worker can reach database/control networks; no container boundary protects against a compromised Docker administrator.
- The browser control endpoint has no application authentication but is not published to the host; only the dedicated trusted control/fixture environment can reach its networks. Fixture-server and worker membership are deliberate and not equivalent to tenant isolation.
- Read APIs and Swagger are public, local HTTP is unencrypted, and Compose credentials are examples. Exposing this service elsewhere requires fresh secrets and an appropriate trusted ingress/TLS configuration. Source URLs/snapshots must not contain credentials. No authentication-bypass or public-browser scraping feature was added.
- The documented upgrade sequence for an old volume was not tested against a separately archived pre-review volume; fresh bootstrap and repeated migration grants were tested. The standard Compose worker has fixture-only network egress; enabling permitted public HTTP sources needs an explicit worker-network design and another boundary test.
- Runtime has operational access to the application and queue data; a compromised runtime can still corrupt those records. Migration owner access is deliberately more powerful. Existing Compose volumes need bootstrap/grant steps, not blind deletion.
- Request limits are single-process/per-IP, reset on restart, and are not a distributed abuse defense. Retention/archival of legitimate run/history/log growth remains operator-managed. No complex monitoring or enterprise permission system was added.
- UTF-8 and conservative URL/markup limits are the supported contract. Other charsets, nested percent encoding, exceptionally deep markup, or more complex catalogs require deliberate future design rather than silent acceptance.
- Deadline cleanup has bounded operational overhead; synchronous parsing cannot be interrupted at an exact millisecond. Tokenizer bounds and container limits reduce that risk. Browser remote cleanup still relies on Playwright/process health.
- A pg deprecation warning appeared for concurrent client queries (the run-detail path and restricted-role regression setup); current pg 8 behavior passed. Future pg upgrades need to address that compatibility warning; no security failure was observed.

## Final status

**SECURITY REVIEW: PASSED for the reviewed V1 scope, with the residual limitations above.** All eight findings were remediated and relevant exploit/regression scenarios retested. This result is limited to the reviewed scope and does not establish production deployment readiness.

| Check                                            | Actual result                                                                                   |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Unit/security tests                              | 33 passed                                                                                       |
| Real PostgreSQL/API integration tests            | 21 passed                                                                                       |
| Playwright extraction/security tests             | 10 passed; no unhandled errors                                                                  |
| Formatting / lint / strict type checking / build | Passed                                                                                          |
| Final npm audit                                  | 0 known vulnerabilities                                                                         |
| Final Compose build/start                        | Passed; five services healthy, migration Exited (0)                                             |
| Final real HTTP source workflows                 | All three succeeded; browser provenance verified                                                |
| Final PostgreSQL history inspection              | One history row for each source after unchanged reruns                                          |
| Final native browser-to-host probe               | No additional packets; original listener total remained four                                    |
| Final recent log inspection                      | Zero supplied secret markers, credential/connection markers, unexpected errors or stack markers |

The disposable Compose environment, networks, PostgreSQL volume, and host listener were removed. Synthetic application/queue records in the existing automated-test database were cleared, and its container was returned to its original stopped state. Its existing schema/volume was retained because it is the reusable development test database; unrelated containers and application data were untouched. No GitHub-hosted CI was executed.

## Files changed during this stage

- Deployment/dependencies: `compose.yaml`, `docker/init-runtime.sql`, `package.json`, `package-lock.json`.
- Runtime privileges: `src/entrypoints/migrate.ts`, `src/shared/runtime-database.ts`.
- Network/configuration: `src/modules/network/http.ts`, `src/config/sources.ts`.
- API/persistence: `src/modules/api/app.ts`, `src/modules/catalog/persistence.ts`, `src/modules/ingestion/runner.ts`.
- Extraction/normalization: `src/modules/extraction/html.ts`, `src/modules/extraction/static.ts`, `src/modules/extraction/browser.ts`, `src/modules/normalization/model.ts`.
- Regression tests: `tests/unit/compose.test.ts`, `tests/unit/extraction.test.ts`, `tests/unit/network.test.ts`, `tests/integration/engine.test.ts`, `tests/browser/extraction.test.ts` (18 added tests).
- Review/remediation documentation: `README.md`, `docs/source-policy.md`, `docs/security-review.md`.

Technical references checked: [Docker gateway modes](https://docs.docker.com/engine/network/port-publishing/#gateway-modes), [Playwright Docker sandbox guidance](https://playwright.dev/docs/docker), [Fastify rate limiting](https://github.com/fastify/fastify-rate-limit), and [OWASP SSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html). The findings above rely on repository/runtime evidence, not those references alone.

## CI container and seccomp review — 13 October 2026

A focused independent read-only review covered the CI changes subsequently published in commit `0a1b314afda8643418987a16f4035112be2e79e2`: workflow failure propagation, `compose.ci.yaml`, the digest-pinned non-root Playwright image, the complete seccomp profile and CI-only chroot derivation, both sandbox verification paths, and disposable-resource cleanup. **No blocking finding was identified in the reviewed changes; the recommendation was approval for hosted validation.** Production browser behavior and security configuration were unchanged.

The CI-only profile removes the chroot rule's CAP_SYS_CHROOT condition, allowing Chromium's nested user-namespace operation while retaining kernel capability checks. The test container drops all outer capabilities and enables no-new-privileges; it uses no privileged mode, unconfined profile, host namespaces, Docker socket, or host credential mounts. The verifier fails on missing evidence and requires separate renderer namespaces and additional seccomp filtering for both launch paths. Local probes recorded denial of outer-process chroot. This scoped syscall allowance is not a claim of complete Chromium/kernel security.

Non-blocking review risks remain: inventory command substitutions can confuse Docker errors with empty inventories; SIGKILL/runner loss can interrupt cleanup; PostgreSQL uses a mutable version tag. Hosted compatibility was pending at review time and subsequently passed in [run 38444687594](https://github.com/Warw0lfLabs/web-data-ingestion-engine/actions/runs/38444687594), with both sandbox records and all 168 tests passing. See the [hosted reconciliation](validation.md#hosted-ci-reconciliation--13-october-2026) for evidence and limits.

This supplements the historical application review within the **V1 local demonstration threat model**. It does not establish production readiness, image-CVE clearance, arbitrary public browser safety, owner acceptance, or walkthrough completion. Those last two owner stages remain **PENDING**.
