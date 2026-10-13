import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
export type FixtureState = {
  html?: string;
  price?: string;
  availability?: string;
  failures?: number;
};
export async function fixtureServer(port = 8080, host = "127.0.0.1") {
  const states = new Map<string, FixtureState>();
  const requests = new Map<string, number>();
  const pages = await Promise.all(
    ["structured", "dom", "javascript"].map(
      async (id) =>
        [
          id,
          await readFile(
            fileURLToPath(
              new URL(`../../tests/fixtures/html/${id}.html`, import.meta.url),
            ),
            "utf8",
          ),
        ] as const,
    ),
  );
  const templates = new Map(pages);
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}`);
    if (url.pathname === "/health/live") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    const id = url.pathname.split("/")[1] ?? "";
    requests.set(url.pathname, (requests.get(url.pathname) ?? 0) + 1);
    const state = states.get(url.pathname) ?? states.get(id) ?? {};
    if (state.failures && state.failures > 0) {
      state.failures--;
      res.writeHead(503, { "content-type": "text/html" });
      res.end("Temporary fixture failure");
      return;
    }
    if (url.pathname === "/javascript/render.js") {
      res.writeHead(200, { "content-type": "application/javascript" });
      res.end(
        `setTimeout(()=>{document.getElementById('catalog').innerHTML=${JSON.stringify(`<article class="product" data-id="chair-1"><h2 class="title">Demonstration Chair</h2><span class="price">${state.price ?? "49.00"}</span><span class="stock">${state.availability ?? "in stock"}</span></article>`)}},25)`,
      );
      return;
    }
    const template = templates.get(id);
    if (!template) {
      res.writeHead(404);
      res.end();
      return;
    }
    let html = state.html ?? template;
    if (state.price)
      html = html.replace(id === "structured" ? "19.99" : "29.50", state.price);
    if (state.availability)
      html = html.replace(
        id === "structured" ? "https://schema.org/InStock" : "in stock",
        state.availability,
      );
    res.writeHead(200, {
      "content-type": "text/html",
      "content-length": Buffer.byteLength(html),
    });
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture address unavailable");
  return { server, states, requests, origin: `http://${host}:${address.port}` };
}
export function closeServer(server: Server) {
  return new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await fixtureServer(Number(process.env.FIXTURE_PORT ?? 8080), "0.0.0.0");
}
