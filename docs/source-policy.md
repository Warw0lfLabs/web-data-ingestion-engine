# Source and network policy

## Permission and trusted configuration

Only owned local fixtures, explicitly permitted demonstration sources, or other sources with affirmative permission may be configured. V1 bundles `structured`, `dom`, and `javascript`; tests/CI do not scrape public catalogs. Before adding a public HTTP source, the operator must check permission, published restrictions, and robots policy. Robots rules alone are not permission; verification is not automated.

Source files are operator-controlled and read-only through the API. TypeBox/Ajv validates origin/path rules, URLs, permission references, selectors, schedules, and limits. Configuration is capped at 1–10 sources and 64 KiB; each run saves its snapshot/hash. Clients cannot submit URLs or initiate arbitrary crawling. Pagination follows configured start URLs and a next-link selector, not general link discovery. Fixture mutation is an in-process test helper without an HTTP mutation API.

## HTTP policy

Every URL must match the configured origin, including scheme/port, and the exact path prefix or a descendant. Credentials, unsupported protocols, encoded separators, nested percent encoding, and NUL paths are rejected. Redirects are handled manually, at most three, repeating URL/DNS checks at each hop; they cannot expand permission boundaries.

Public policy requires HTTPS and forbids browser extraction. Every resolved address must pass the public-address check; any private/reserved answer rejects the request. The checked address is pinned into the connection. Fixture policy allows internal addresses only for configured `localhost`, `127.0.0.1`, or `fixture-server`. Operators must not repoint that exception at another internal service. Trusted configuration/Docker administration are outside the untrusted-client boundary.

## Processing bounds

Downloaded HTML, structured data, and fixture JavaScript are untrusted. Fetches use pacing, timeouts, bounded UTF-8 resources, and supported content types. Unexpected compression/charsets are rejected. JSON-LD script size/count and traversal, candidates, normalized strings, and attributes are bounded; invalid records are rejected before parameterized SQL persistence. Raw HTML and secrets must not be logged.

| Boundary          | Maximum                                                        |
| ----------------- | -------------------------------------------------------------- |
| Fetch URL         | 2,048 characters                                               |
| Response          | 2 MiB                                                          |
| Run               | Ten minutes, 20 pages, 500 accepted plus rejected candidates   |
| HTML parsing      | Depth 128, 20,000 tokenizer events, 100 attributes per element |
| Browser resources | 30 intercepted requests with a cumulative byte budget          |

Replay/resumption is recorded in PostgreSQL. Bounds are conservative V1 support limits, not permission to fetch an otherwise prohibited source.

## Browser and exposure rules

Browser rendering requires fixture policy and explicit source enablement. Access-denial responses end the attempt, never enable fallback. Intercepted GET resources use the controlled client and origin/path rules; rendering has a shared deadline and one global extraction slot. Service workers, WebSockets, popups, and download acceptance are blocked.

Interception does not govern every native browser network path. Compose adds separate sandboxed fixture/control networks without browser API/database membership, using isolated internal IPv4 bridges. Host browsers do not inherit this boundary. See [security](security.md) and the [recorded connectivity tests](verification/security-review.md#sr-01-docker-host-reachability); no arbitrary public browser safety guarantee is made.

Bundled worker networks support fixtures. Permitted public HTTP sources need an explicit network/configuration change and permission review. Public-site browser scraping remains unsupported. Do not add CAPTCHA solving, proxy rotation, fingerprint spoofing, stealth/evasion, authentication bypass, anti-bot bypass, or access-control bypass; stop on restrictions.

Reads and Swagger are public; triggers require the operator token and single-process per-IP limits. Change example credentials before external exposure. Production ingress/TLS/deployment has not been validated; local Compose publishes only the API on loopback.
