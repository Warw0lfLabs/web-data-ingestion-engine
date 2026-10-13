import { it, expect, beforeAll, afterAll } from "vitest";
import { fixtureServer, closeServer } from "../../src/entrypoints/fixtures.js";
import { demoSources } from "../../src/config/sources.js";
import { BrowserExtractor } from "../../src/modules/extraction/browser.js";
import { extract } from "../../src/modules/extraction/static.js";
let fixture: Awaited<ReturnType<typeof fixtureServer>>;
beforeAll(async () => {
  fixture = await fixtureServer(0);
});
afterAll(async () => {
  await closeServer(fixture.server);
});
it("extracts JS content through bounded fixture-only browser fallback", async () => {
  const source = demoSources(fixture.origin)[2]!;
  source.limits.intervalMs = 10;
  const html = await new BrowserExtractor().html(source.startUrls[0]!, source);
  expect(extract(html, source, source.startUrls[0]!).offers[0]).toMatchObject({
    externalKey: "chair-1",
    price: "49.000000",
  });
}, 30000);
it("forbids public browser sources", async () => {
  const source = demoSources(fixture.origin)[2]!;
  source.networkPolicy = "public";
  await expect(
    new BrowserExtractor().html(source.startUrls[0]!, source),
  ).rejects.toThrow("BROWSER_FORBIDDEN");
});
it("times out deterministically when readiness never appears", async () => {
  const source = demoSources(fixture.origin)[2]!;
  source.extraction.browser.readySelector = ".never";
  source.limits.browserTimeoutMs = 300;
  source.limits.intervalMs = 10;
  await expect(
    new BrowserExtractor().html(source.startUrls[0]!, source),
  ).rejects.toThrow("BROWSER_TIMEOUT");
}, 10000);

it("blocks browser subrequests outside the configured fixture path", async () => {
  const source = demoSources(fixture.origin)[2]!;
  source.limits.intervalMs = 10;
  fixture.states.set("javascript", {
    html: `<html><body><script src="${fixture.origin}/structured"></script><article class="product">Ready</article></body></html>`,
  });
  try {
    await expect(
      new BrowserExtractor().html(source.startUrls[0]!, source),
    ).rejects.toThrow("BROWSER_NETWORK_REJECTED");
  } finally {
    fixture.states.clear();
  }
}, 10000);
it("enforces byte limits before browser resource fulfillment", async () => {
  const source = demoSources(fixture.origin)[2]!;
  source.limits.intervalMs = 10;
  source.limits.maxBytes = 100;
  fixture.states.set("javascript", {
    html: "<html><body>" + "x".repeat(1000) + "</body></html>",
  });
  try {
    await expect(
      new BrowserExtractor().html(source.startUrls[0]!, source),
    ).rejects.toThrow();
  } finally {
    fixture.states.clear();
  }
}, 10000);

it("supports the separate Playwright server connection used by Compose", async () => {
  const { chromium } = await import("playwright");
  const server = await chromium.launchServer({ chromiumSandbox: true });
  const source = demoSources(fixture.origin)[2]!;
  source.limits.intervalMs = 10;
  try {
    const html = await new BrowserExtractor(server.wsEndpoint()).html(
      source.startUrls[0]!,
      source,
    );
    expect(
      extract(html, source, source.startUrls[0]!).offers[0]?.externalKey,
    ).toBe("chair-1");
  } finally {
    await server.close();
  }
}, 30000);

it("bounds browser queue waiting and leaves subsequent extraction usable", async () => {
  const extractor = new BrowserExtractor();
  const slow = demoSources(fixture.origin)[2]!;
  slow.limits.intervalMs = 10;
  slow.limits.browserTimeoutMs = 1000;
  slow.extraction.browser.readySelector = ".never";
  const first = extractor.html(slow.startUrls[0]!, slow).catch(() => {});
  const queued = demoSources(fixture.origin)[2]!;
  queued.limits.browserTimeoutMs = 100;
  const start = Date.now();
  await expect(extractor.html(queued.startUrls[0]!, queued)).rejects.toThrow(
    "BROWSER_TIMEOUT",
  );
  expect(Date.now() - start).toBeLessThan(700);
  await first;
  const healthy = demoSources(fixture.origin)[2]!;
  healthy.limits.intervalMs = 10;
  expect(await extractor.html(healthy.startUrls[0]!, healthy)).toContain(
    "chair-1",
  );
}, 15000);
it("rejects WebSockets and popups created by hostile fixture scripts", async () => {
  const source = demoSources(fixture.origin)[2]!;
  source.limits.intervalMs = 10;
  for (const [script, code] of [
    [`new WebSocket('ws://127.0.0.1:9/')`, "BROWSER_WEBSOCKET_REJECTED"],
    [`window.open('about:blank')`, "BROWSER_POPUP_REJECTED"],
  ]) {
    fixture.states.set("javascript", {
      html: `<html><body><script>${script};setTimeout(()=>document.body.insertAdjacentHTML('beforeend','<div class="product">Ready</div>'),200)</script></body></html>`,
    });
    try {
      await expect(
        new BrowserExtractor().html(source.startUrls[0]!, source),
      ).rejects.toThrow(code!);
    } finally {
      fixture.states.clear();
    }
  }
}, 15000);
it("creates fresh browser contexts without persisted source cookies", async () => {
  const source = demoSources(fixture.origin)[2]!;
  source.limits.intervalMs = 10;
  fixture.states.set("javascript", {
    html: `<html><body><script>document.body.innerHTML='<div class="product">'+(document.cookie || 'empty')+'</div>';document.cookie='sentinel=secret';</script></body></html>`,
  });
  try {
    const extractor = new BrowserExtractor();
    for (let i = 0; i < 2; i++)
      expect(await extractor.html(source.startUrls[0]!, source)).toContain(
        'class="product">empty',
      );
  } finally {
    fixture.states.clear();
  }
}, 15000);

it("enforces a shared byte budget across concurrent browser resources", async () => {
  const { createServer } = await import("node:http");
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    if (req.url === "/javascript") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        '<script src="/javascript/one.js"></script><script src="/javascript/two.js"></script><div class="product">Ready</div>',
      );
    } else {
      res.writeHead(200, { "content-type": "application/javascript" });
      res.end("/*" + "x".repeat(600) + "*/");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("port");
  const source = demoSources(`http://127.0.0.1:${address.port}`)[2]!;
  source.limits.maxBytes = 1000;
  source.limits.intervalMs = 10;
  try {
    await expect(
      new BrowserExtractor().html(source.startUrls[0]!, source),
    ).rejects.toThrow("BROWSER_NETWORK_REJECTED");
    expect(requests).toBeLessThanOrEqual(3);
  } finally {
    await closeServer(server);
  }
}, 10000);
