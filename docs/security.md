# Security boundaries

V1 is a local demonstration service using owned fixtures. API clients and downloaded HTML/JSON-LD/JavaScript are untrusted. Source configuration, deployment settings, migration credentials, and Docker administration are trusted. The project is not a multi-tenant platform, and these controls do not establish production readiness.

## Fetching and untrusted input

Clients cannot supply fetch URLs or edit sources through the API. Trusted source files define an exact origin/path boundary. Every request, pagination link, and redirect is checked; credentials, unsupported protocols, encoded separators/nested encodings, and NUL paths are rejected. Public HTTP policy requires HTTPS, rejects any private/reserved DNS answer, and pins a checked address into the connection while preserving TLS hostname verification. Redirects repeat URL/DNS validation and cannot expand source permissions.

Owned fixture policy explicitly permits configured local hosts, not arbitrary internal fetching. Responses have byte/time limits; unexpected compression and unsupported content types/charsets are rejected. HTML structure, JSON-LD traversal, candidate counts, strings, pages, and total run time are bounded. Normalized offers are validated before parameterized SQL writes. See [source policy](source-policy.md) for permissions and supported bounds.

## Browser boundary

Browser extraction requires fixture policy and explicit source enablement. Access denial never causes browser fallback. Intercepted GET resources are fetched through the controlled client with a cumulative byte budget and request/time limits. Fresh contexts block service workers, WebSockets, popups, and download acceptance.

Interception is **not complete browser network isolation**: native browser traffic can use paths outside request routing. Production Compose therefore separates the sandboxed non-root browser onto fixture/control networks, without API/database membership. Internal IPv4 bridges remove host gateways in the tested environment. Host-launched browsers do not inherit that boundary; arbitrary hostile public browser workloads and full IPv6 isolation are unvalidated.

The CI environment is separate from production Compose. It uses a digest-pinned non-root Playwright image, zero outer capabilities, no-new-privileges, resource limits, and a CI-only seccomp derivation allowing Chromium's nested-namespace chroot syscall. Kernel capability checks remain active. Direct/server checks require renderer namespace separation and an additional seccomp filter; missing evidence fails validation. No privileged/unconfined container or sandbox-disabling flag is used. This is scoped sandbox evidence, not proof against Chromium/kernel exploits.

## API, database, and credentials

Manual triggers require a bearer token checked with timing-safe comparison. Reads and Swagger are intentionally public. Per-IP limits are 120 general requests/minute and 10 triggers/minute, held in one process and reset on restart. They are not distributed abuse protection.

Compose publishes the API only on loopback. Example tokens/passwords are demonstration credentials; change them before external exposure and never put credentials in source URLs. Migration runs with owner privileges; API/worker use a non-superuser operational role without schema creation or migration-table writes. Compromised runtime access can still corrupt operational catalog/queue data. Logs redact sensitive fields and avoid raw HTML, configuration snapshots, and reflected client query strings.

## Review scope and residual risks

The historical application review recorded eight remediated findings with exploit/regression retests. The focused CI review found no blocker in the reviewed changes. Hosted sandbox checks subsequently passed at the tested baseline. The [complete review](verification/security-review.md) preserves methods, dates, findings, and limitations; its dated dependency-advisory result is not a current vulnerability clearance.

Production ingress/TLS, container-image vulnerability scanning, full IPv6 coverage, archived-volume upgrades, and public-source deployments remain unvalidated. Production images and PostgreSQL use mutable version tags. CI inventory checks can confuse Docker errors with empty output; forced termination can interrupt cleanup. Runtime data retention is operator-managed, and browser/process cleanup depends on infrastructure health. Native whole-stack restart remains unsupported; use the [operational workflow](operations.md#supported-restart).

Owner smoke testing was executed, but the walkthrough, owner acknowledgment, and final acceptance are still pending. No review or successful CI run completes those stages or provides an unrestricted security guarantee.
