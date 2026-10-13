import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { demoSources } from "../../src/config/sources.js";
import {
  publicAddress,
  permittedUrl,
  checkedAddresses,
  fetchHtml,
  Pacer,
} from "../../src/modules/network/http.js";
import { closeServer } from "../../src/entrypoints/fixtures.js";
let server: Server;
let origin: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/dom/invalid-utf8") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(Buffer.from([0xc0]));
    } else if (req.url === "/dom/other-charset") {
      res.writeHead(200, { "content-type": "text/html; charset=iso-8859-1" });
      res.end("unsupported charset");
    } else if (req.url === "/dom/redirect") {
      res.writeHead(302, {
        location: "http://169.254.169.254/latest/meta-data",
      });
      res.end();
    } else if (req.url === "/dom/loop") {
      res.writeHead(302, { location: "/dom/loop" });
      res.end();
    } else if (req.url === "/dom/large") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("x".repeat(1000));
    } else if (req.url === "/dom/slow") {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("late");
      }, 200);
    } else if (req.url === "/dom/retry") {
      res.writeHead(429, { "retry-after": "1" });
      res.end();
    } else if (req.url === "/dom/compressed") {
      res.writeHead(200, {
        "content-type": "text/html",
        "content-encoding": "gzip",
      });
      res.end("fake");
    } else {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<h1>ok</h1>");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("port");
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  await closeServer(server);
});
describe("controlled HTTP security", () => {
  it("classifies reserved, private and mapped addresses", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.1.1",
      "169.254.169.254",
      "::1",
      "::ffff:127.0.0.1",
      "fc00::1",
      "0.0.0.0",
      "100.64.0.1",
    ])
      expect(publicAddress(ip)).toBe(false);
    expect(publicAddress("8.8.8.8")).toBe(true);
  });
  it("rejects credentials, paths and origins outside policy", () => {
    const source = demoSources(origin)[1]!;
    for (const url of [
      "file:///etc/passwd",
      `${origin}/structured`,
      origin.replace("http://", "http://user:pass@") + "/dom",
      `${origin}/dom/%2fsecret`,
    ])
      expect(() => permittedUrl(url, source)).toThrow("URL_REJECTED");
  });
  it("rejects mixed DNS answers and rebinding results", async () => {
    const source = {
      ...demoSources(origin)[1]!,
      networkPolicy: "public" as const,
    };
    await expect(
      checkedAddresses(new URL(origin), source, async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ]),
    ).rejects.toThrow("SSRF_REJECTED");
  });
  it("fetches allowed HTML", async () => {
    const source = demoSources(origin)[1]!;
    expect((await fetchHtml(`${origin}/dom`, source, new Pacer(10))).html).toBe(
      "<h1>ok</h1>",
    );
  });
  it("validates every redirect and bounds redirects", async () => {
    const source = demoSources(origin)[1]!;
    await expect(
      fetchHtml(`${origin}/dom/redirect`, source, new Pacer(10)),
    ).rejects.toThrow("URL_REJECTED");
    await expect(
      fetchHtml(`${origin}/dom/loop`, source, new Pacer(10)),
    ).rejects.toThrow("REDIRECT_LIMIT");
  });
  it("bounds responses and rejects unexpected compression", async () => {
    const source = demoSources(origin)[1]!;
    source.limits.maxBytes = 100;
    await expect(
      fetchHtml(`${origin}/dom/large`, source, new Pacer(10)),
    ).rejects.toThrow("RESPONSE_TOO_LARGE");
    await expect(
      fetchHtml(`${origin}/dom/compressed`, source, new Pacer(10)),
    ).rejects.toThrow("UNSUPPORTED_ENCODING");
  });
  it("times out and classifies 429 with retry-after", async () => {
    const source = demoSources(origin)[1]!;
    source.limits.httpTimeoutMs = 100;
    await expect(
      fetchHtml(`${origin}/dom/slow`, source, new Pacer(10)),
    ).rejects.toThrow("TIMEOUT");
    await expect(
      fetchHtml(`${origin}/dom/retry`, source, new Pacer(10)),
    ).rejects.toMatchObject({ retryable: true, retryAfterMs: 1000 });
  });
});

it("bounds DNS resolution time", async () => {
  const source = demoSources(origin)[1]!;
  source.limits.httpTimeoutMs = 100;
  await expect(
    fetchHtml(
      `${origin}/dom`,
      source,
      new Pacer(10),
      undefined,
      () => new Promise(() => {}),
    ),
  ).rejects.toThrow("TIMEOUT");
});
it("paces successive requests", async () => {
  const source = demoSources(origin)[1]!;
  const pacer = new Pacer(60);
  const start = Date.now();
  await fetchHtml(`${origin}/dom`, source, pacer);
  await fetchHtml(`${origin}/dom`, source, pacer);
  expect(Date.now() - start).toBeGreaterThanOrEqual(55);
});

it("pins hostname connections to the checked address rather than resolving again", async () => {
  const hostnameOrigin = origin.replace("127.0.0.1", "localhost");
  const source = demoSources(hostnameOrigin)[1]!;
  let resolutions = 0;
  const result = await fetchHtml(
    `${hostnameOrigin}/dom`,
    source,
    new Pacer(10),
    undefined,
    async () => {
      resolutions++;
      return [{ address: "127.0.0.1", family: 4 }];
    },
  );
  expect(result.html).toContain("ok");
  expect(resolutions).toBe(1);
});
it("rejects alternate numeric loopback forms after URL canonicalization", () => {
  const source = demoSources(origin)[0]!;
  for (const url of [
    "http://2130706433/dom",
    "http://0x7f000001/dom",
    "http://0177.0.0.1/dom",
  ])
    expect(() => permittedUrl(url, source)).toThrow("URL_REJECTED");
});

it("rejects nested encoded separators/traversal, NUL and oversized URLs", () => {
  const source = demoSources(origin)[1]!;
  for (const path of [
    "/dom/%252e%252e/structured",
    "/dom/%252fsecret",
    "/dom/%00",
    "/dom?x=" + "x".repeat(2048),
  ])
    expect(() => permittedUrl(origin + path, source)).toThrow("URL_REJECTED");
  expect(permittedUrl(origin + "/dom/caf%C3%A9", source).pathname).toBe(
    "/dom/caf%C3%A9",
  );
});

it("rejects additional non-public IPv4 and IPv6 destinations", () => {
  for (const ip of [
    "127.2.3.4",
    "172.16.0.1",
    "192.168.1.1",
    "192.0.0.1",
    "192.0.2.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "255.255.255.255",
    "fe80::1",
    "ff02::1",
    "2001:db8::1",
    "::ffff:169.254.169.254",
    "64:ff9b::7f00:1",
  ])
    expect(publicAddress(ip)).toBe(false);
});
it("preserves TLS hostname verification when connections are IP-pinned", async () => {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync, execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { createServer } = await import("node:https");
  const dir = await mkdtemp(join(tmpdir(), "ingestion-tls-test-"));
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
    ],
    { stdio: "ignore", timeout: 10000 },
  );
  const tls = createServer(
    { key: await readFile(key), cert: await readFile(cert) },
    (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("trusted TLS");
    },
  );
  await new Promise<void>((r) => tls.listen(0, "127.0.0.1", r));
  const addr = tls.address();
  if (!addr || typeof addr === "string") throw new Error("port");
  try {
    const script = `import {demoSources} from './src/config/sources.ts';import {fetchHtml,Pacer} from './src/modules/network/http.ts';for(const host of ['localhost','fixture-server']){const origin='https://'+host+':${addr.port}';try{console.log(host,(await fetchHtml(origin+'/dom',demoSources(origin)[1],new Pacer(10),undefined,async()=>[{address:'127.0.0.1',family:4}])).html)}catch(e){console.log(host,e.code)}}`;
    const result = await promisify(execFile)(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      {
        env: {
          ...process.env,
          NODE_EXTRA_CA_CERTS: cert,
          HTTP_PROXY: "http://127.0.0.1:9",
          HTTPS_PROXY: "http://127.0.0.1:9",
        },
        timeout: 10000,
      },
    );
    expect(result.stdout).toContain("localhost trusted TLS");
    expect(result.stdout).toContain("fixture-server NETWORK_ERROR");
  } finally {
    await closeServer(tls);
    await rm(dir, { recursive: true, force: true });
  }
}, 20000);

it("rejects lossy text decoding and unsupported character encodings", async () => {
  const source = demoSources(origin)[1]!;
  await expect(
    fetchHtml(`${origin}/dom/invalid-utf8`, source, new Pacer(10)),
  ).rejects.toThrow("INVALID_TEXT_ENCODING");
  await expect(
    fetchHtml(`${origin}/dom/other-charset`, source, new Pacer(10)),
  ).rejects.toThrow("UNSUPPORTED_CHARSET");
});
