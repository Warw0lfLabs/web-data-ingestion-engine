# Source and network policy

## Trusted configuration and permission

Only owned local fixtures, demonstration sources with explicit permission, or other explicitly permitted sources may be configured. V1 bundles `structured` (JSON-LD), `dom` (CSS selectors), and `javascript` (browser rendering). Tests and CI do not scrape public catalogs.

Source files are operator-controlled and read-only from the API. TypeBox/Ajv validates source IDs, permission references, start URLs, allowed origin/path, selectors, schedules, and limits. Configuration is limited to 1–10 sources and 64 KiB. Each run records its configuration snapshot/hash. Clients cannot submit URLs, change configuration, or initiate arbitrary crawling.

A source needs an affirmative permission basis before addition. The operator must check published restrictions and robots policy for a permitted public HTTP source; robots rules alone are not permission. The service does not automate permission verification. Fixture state mutation is an in-process test helper with no HTTP mutation API.

## HTTP and SSRF boundary

Every URL must match the configured origin (including scheme/port) and exact path prefix or a descendant path. Credentials in URLs, unsupported protocols, encoded path separators, nested percent encoding, and NUL are rejected; fetch URLs are capped at 2,048 characters.

Public-policy sources require HTTPS and cannot enable browsers. All resolved addresses must pass the public-address check, rejecting private/reserved destinations; the selected checked address is pinned into the actual connection. Redirects are handled manually, at most three, with URL rules and DNS checks repeated for each hop. A redirect cannot expand the source's allowed origin or path.

Fixture policy deliberately permits internal addresses but restricts configured hostnames to `localhost`, `127.0.0.1`, or `fixture-server`. This is an exception for owned demonstration services, not a general internal-fetch facility. Operators must not point it at another internal service. Trusted configuration/Docker administration are outside the untrusted-client boundary.

Pagination follows only a configured next-link selector or configured start URLs. Every followed URL uses the same network rules; there is no link discovery crawler. Source limits cap pages at 20 and accepted plus rejected candidates at 500 per run, with replay/resumption recorded in PostgreSQL.

## Untrusted input and resource limits

Downloaded HTML, structured data, and fixture JavaScript are untrusted. HTTP uses explicit pacing and timeouts and accepts bounded UTF-8 resources. Unexpected compression and unsupported content types/charsets are rejected. Configurable response limits cannot exceed 2 MiB; a run cannot exceed ten minutes.

HTML structure is checked before DOM construction: depth 128, 20,000 tokenizer events, and 100 attributes per element. JSON-LD script size/count, traversal depth/count, candidates, strings, and normalized values are bounded. Invalid records are rejected before persistence; raw HTML and secrets must not be logged. SQL uses parameterized values.

## Browser fixture boundary

Playwright is available only when fixture policy and source browser enablement both allow it. Access-denial responses end the attempt; they never enable browser fallback. Intercepted browser GET resources use the controlled HTTP client and origin/path policy, with at most 30 requests and a cumulative byte budget. Service workers, WebSockets, popups, and downloads are blocked. Rendering has a deadline and one global extraction slot.

Compose runs Chromium in a separate sandboxed browser container on fixture/control networks, without API/database network membership. Internal bridges use isolated gateway mode. Browser native networking is not fully governed by Playwright request interception, so network isolation is part of the boundary. Local Compose connectivity/native-network tests are documented in [security review](security-review.md); this is not a guarantee for arbitrary hostile public browser workloads or every host/network configuration. Host-launched browser tests do not inherit Compose isolation.

The bundled worker networks support the owned fixtures. Adding an explicitly permitted public HTTP source requires a deliberate network/configuration change and permission review. Public-site browser scraping remains unsupported.

## Unsupported behavior and API exposure

Do not add CAPTCHA solving, proxy rotation, fingerprint spoofing, stealth/evasion, authentication bypass, anti-bot bypass, or access-control bypass. Stop on restrictions rather than trying alternative access mechanisms.

Read endpoints and Swagger are intentionally public. Manual triggers require the operator token and have single-process per-IP limits. Change the demonstration token before external exposure. Production ingress/TLS/deployment has not been validated; local Compose publishes only the API on loopback.
