import { beforeAll, afterAll, beforeEach, it, expect } from "vitest";
import { runner } from "node-pg-migrate";
import { makeWorkerUtils, runOnce } from "graphile-worker";
import { createPool } from "../../src/shared/database.js";
import { fixtureServer, closeServer } from "../../src/entrypoints/fixtures.js";
import { demoSources } from "../../src/config/sources.js";
import { createRun, syncSources } from "../../src/modules/jobs/runs.js";
import { scheduleDue } from "../../src/modules/jobs/scheduler.js";
import { executeRun } from "../../src/modules/ingestion/runner.js";
import { BrowserExtractor } from "../../src/modules/extraction/browser.js";
import { buildApp } from "../../src/modules/api/app.js";
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error("TEST_DATABASE_URL must name a disposable *_test database");
const pool = createPool(url);
let fixture: Awaited<ReturnType<typeof fixtureServer>>;
let sources: ReturnType<typeof demoSources>;
const browser = new BrowserExtractor();
beforeAll(async () => {
  await runner({
    databaseUrl: url,
    dir: "migrations",
    direction: "up",
    migrationsTable: "app_migrations",
    log: () => {},
  });
  const utils = await makeWorkerUtils({ connectionString: url });
  await utils.migrate();
  await utils.release();
  fixture = await fixtureServer(0);
  sources = demoSources(fixture.origin);
  for (const s of sources) s.limits.intervalMs = 10;
}, 30000);
beforeEach(async () => {
  await pool.query(
    "TRUNCATE offer_history,offer_current,variants,products,ingestion_page_results,ingestion_attempts,ingestion_runs,sources CASCADE",
  );
  await pool.query("DELETE FROM graphile_worker._private_jobs");
  await syncSources(pool, sources);
  fixture.states.clear();
});
afterAll(async () => {
  await closeServer(fixture.server);
  await pool.end();
});
async function ingest(index = 0) {
  const source = sources[index]!;
  const created = await createRun(pool, source, "manual");
  await executeRun(pool, created.id, browser);
  return created.id;
}
it("stores initial data, deduplicates unchanged reruns, tracks changes and replay", async () => {
  const first = await ingest();
  await executeRun(pool, first, browser);
  await ingest();
  expect((await pool.query("SELECT * FROM offer_history")).rowCount).toBe(1);
  fixture.states.set("structured", { price: "17.00" });
  await ingest();
  fixture.states.set("structured", {
    price: "17.00",
    availability: "https://schema.org/OutOfStock",
  });
  await ingest();
  fixture.states.set("structured", {
    price: "19.99",
    availability: "https://schema.org/InStock",
  });
  await ingest();
  expect((await pool.query("SELECT * FROM offer_history")).rowCount).toBe(4);
  expect(
    (await pool.query("SELECT price,availability FROM offer_current")).rows[0],
  ).toEqual({ price: "19.990000", availability: "in_stock" });
});
it("persists static DOM scenario", async () => {
  const id = await ingest(1);
  expect(
    (
      await pool.query(
        "SELECT status,accepted FROM ingestion_runs WHERE id=$1",
        [id],
      )
    ).rows[0],
  ).toEqual({ status: "succeeded", accepted: 1 });
});
it("queues bounded retry after transient failure, then succeeds", async () => {
  fixture.states.set("structured", { failures: 1 });
  const id = await ingest();
  expect(
    (
      await pool.query(
        "SELECT status,attempt FROM ingestion_runs WHERE id=$1",
        [id],
      )
    ).rows[0],
  ).toEqual({ status: "retrying", attempt: 1 });
  await executeRun(pool, id, browser);
  expect(
    (
      await pool.query(
        "SELECT status,attempt FROM ingestion_runs WHERE id=$1",
        [id],
      )
    ).rows[0],
  ).toEqual({ status: "succeeded", attempt: 2 });
  expect(
    (await pool.query("SELECT * FROM ingestion_attempts WHERE run_id=$1", [id]))
      .rowCount,
  ).toBe(2);
});
it("stops after bounded transient retries", async () => {
  fixture.states.set("structured", { failures: 20 });
  const id = await ingest();
  for (let i = 0; i < 3; i++) await executeRun(pool, id, browser);
  expect(
    (
      await pool.query(
        "SELECT status,attempt,error_code FROM ingestion_runs WHERE id=$1",
        [id],
      )
    ).rows[0],
  ).toEqual({ status: "failed", attempt: 4, error_code: "HTTP_503" });
});
it("prevents overlap and preserves trigger idempotency", async () => {
  const result = await createRun(pool, sources[0]!, "manual", {
    idempotencyKey: "same",
  });
  expect(
    await createRun(pool, sources[0]!, "manual", { idempotencyKey: "same" }),
  ).toEqual({ id: result.id, reused: true });
  await expect(createRun(pool, sources[0]!, "manual")).rejects.toThrow(
    "SOURCE_BUSY",
  );
});
it("schedules one occurrence and executes real Graphile jobs", async () => {
  await scheduleDue(pool, [sources[0]!]);
  await scheduleDue(pool, [sources[0]!]);
  await runOnce({
    connectionString: url,
    taskList: {
      ingest: async (payload) => {
        await executeRun(pool, (payload as { runId: string }).runId, browser);
      },
    },
  });
  expect((await pool.query("SELECT status FROM ingestion_runs")).rows).toEqual([
    { status: "succeeded" },
  ]);
});
it("exposes validated API, trigger auth, data and OpenAPI", async () => {
  const app = await buildApp(pool, sources, "development-only-change-me");
  try {
    expect((await app.inject("/health/live")).statusCode).toBe(200);
    expect((await app.inject("/health/ready")).statusCode).toBe(200);
    expect((await app.inject("/v1/sources")).json().items).toHaveLength(3);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/sources/structured/runs",
          payload: {},
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/sources/structured/runs",
          headers: { authorization: "Bearer development-only-change-me" },
          payload: { url: "http://evil.test" },
        })
      ).statusCode,
    ).toBe(400);
    const response = await app.inject({
      method: "POST",
      url: "/v1/sources/structured/runs",
      headers: { authorization: "Bearer development-only-change-me" },
      payload: {},
    });
    expect(response.statusCode).toBe(202);
    await executeRun(pool, response.json().id, browser);
    expect(
      (await app.inject(`/v1/runs/${response.json().id}`)).json().status,
    ).toBe("succeeded");
    const products = (await app.inject("/v1/products")).json().items;
    const detail = (await app.inject(`/v1/products/${products[0].id}`)).json();
    expect(
      (await app.inject(`/v1/variants/${detail.variants[0].id}/history`)).json()
        .items,
    ).toHaveLength(1);
    expect((await app.inject("/v1/products?limit=101")).statusCode).toBe(400);
    expect(
      (await app.inject("/docs/json")).json().paths["/v1/products"],
    ).toBeDefined();
    const trigger = (await app.inject("/docs/json")).json().paths[
      "/v1/sources/{id}/runs"
    ].post;
    expect(trigger.responses["202"]).toBeDefined();
    expect(trigger.responses["401"]).toBeDefined();
    expect(trigger.responses["409"]).toBeDefined();
    expect(trigger.responses["200"]).toBeUndefined();
  } finally {
    await app.close();
  }
});

it("runs the complete JavaScript fallback pipeline and persists browser provenance", async () => {
  const id = await ingest(2);
  expect(
    (
      await pool.query(
        "SELECT status,accepted FROM ingestion_runs WHERE id=$1",
        [id],
      )
    ).rows[0],
  ).toEqual({ status: "succeeded", accepted: 1 });
  expect(
    (
      await pool.query(
        "SELECT extractor FROM ingestion_page_results WHERE run_id=$1",
        [id],
      )
    ).rows[0]?.extractor,
  ).toBe("browser");
}, 30000);

it("resumes only unfinished pagination pages after a transient failure", async () => {
  fixture.requests.clear();
  fixture.states.set("/dom", {
    html: '<article class="product" data-id="one"><span class="title">One</span><span class="price">10</span><span class="stock">in stock</span></article><a class="next" href="/dom/page-2">Next</a>',
  });
  fixture.states.set("/dom/page-2", {
    failures: 1,
    html: '<article class="product" data-id="two"><span class="title">Two</span><span class="price">20</span><span class="stock">in stock</span></article>',
  });
  const id = await ingest(1);
  expect(
    (await pool.query("SELECT status FROM ingestion_runs WHERE id=$1", [id]))
      .rows[0]?.status,
  ).toBe("retrying");
  await executeRun(pool, id, browser);
  expect(fixture.requests.get("/dom")).toBe(1);
  expect(fixture.requests.get("/dom/page-2")).toBe(2);
  expect((await pool.query("SELECT * FROM offer_history")).rowCount).toBe(2);
  expect(
    (
      await pool.query("SELECT * FROM ingestion_page_results WHERE run_id=$1", [
        id,
      ])
    ).rowCount,
  ).toBe(2);
});

it("bounds pagination and preserves partial results", async () => {
  const source = {
    ...sources[1]!,
    limits: { ...sources[1]!.limits, maxPages: 1 },
  };
  fixture.states.set("/dom", {
    html: '<article class="product" data-id="one"><span class="title">One</span><span class="price">10</span><span class="stock">in stock</span></article><a class="next" href="/dom/page-2">Next</a>',
  });
  const { id } = await createRun(pool, source, "manual");
  await executeRun(pool, id, browser);
  expect(
    (
      await pool.query(
        "SELECT status,error_code FROM ingestion_runs WHERE id=$1",
        [id],
      )
    ).rows[0],
  ).toEqual({ status: "partial", error_code: "PAGE_LIMIT" });
});

it("rolls back all page writes if persistence fails halfway through", async () => {
  const { persistPage } =
    await import("../../src/modules/catalog/persistence.js");
  const { id } = await createRun(pool, sources[0]!, "manual");
  await pool.query("UPDATE ingestion_runs SET status='running' WHERE id=$1", [
    id,
  ]);
  const offer = {
    externalKey: "good",
    title: "Good",
    url: sources[0]!.startUrls[0]!,
    variantKey: "default",
    attributes: {},
    price: "10.000000",
    currency: "USD",
    availability: "in_stock" as const,
  };
  await expect(
    persistPage(pool, id, "structured", offer.url, {
      offers: [offer, { ...offer, externalKey: "bad", price: "-1.000000" }],
      extractor: "test",
      rejected: 0,
    }),
  ).rejects.toThrow();
  expect((await pool.query("SELECT * FROM products")).rowCount).toBe(0);
  expect((await pool.query("SELECT * FROM offer_history")).rowCount).toBe(0);
  expect(
    (await pool.query("SELECT * FROM ingestion_page_results")).rowCount,
  ).toBe(0);
});

it("does not erase known state when a later record is invalid", async () => {
  await ingest(1);
  fixture.states.set("dom", { price: "not-a-price" });
  const id = await ingest(1);
  expect(
    (
      await pool.query(
        "SELECT status,rejected FROM ingestion_runs WHERE id=$1",
        [id],
      )
    ).rows[0],
  ).toEqual({ status: "failed", rejected: 1 });
  expect(
    (await pool.query("SELECT price FROM offer_current")).rows[0]?.price,
  ).toBe("29.500000");
  expect((await pool.query("SELECT * FROM offer_history")).rowCount).toBe(1);
});

it("expires stale runs without fetching and prevents replay after finalization", async () => {
  const { id } = await createRun(pool, sources[0]!, "manual");
  await pool.query(
    "UPDATE ingestion_runs SET deadline=now()-interval '1 second' WHERE id=$1",
    [id],
  );
  await executeRun(pool, id, browser);
  await executeRun(pool, id, browser);
  expect(
    (
      await pool.query(
        "SELECT status,error_code,attempt FROM ingestion_runs WHERE id=$1",
        [id],
      )
    ).rows[0],
  ).toEqual({ status: "failed", error_code: "RUN_DEADLINE", attempt: 0 });
  expect((await pool.query("SELECT * FROM products")).rowCount).toBe(0);
});

it("respects queued retry due time through Graphile delivery", async () => {
  fixture.states.set("structured", { failures: 1 });
  const { id } = await createRun(pool, sources[0]!, "manual");
  const tasks = {
    ingest: async (payload: unknown) => {
      await executeRun(pool, (payload as { runId: string }).runId, browser);
    },
  };
  await runOnce({ connectionString: url, taskList: tasks });
  const pending = await pool.query<{ run_at: Date }>(
    "SELECT run_at FROM graphile_worker.jobs WHERE key=$1",
    [`${id}:2`],
  );
  expect(pending.rows[0]!.run_at.getTime()).toBeGreaterThan(Date.now());
  expect(
    (await pool.query("SELECT status FROM ingestion_runs WHERE id=$1", [id]))
      .rows[0]?.status,
  ).toBe("retrying");
  await pool.query(
    "UPDATE graphile_worker._private_jobs SET run_at=now() WHERE key=$1",
    [`${id}:2`],
  );
  await runOnce({ connectionString: url, taskList: tasks });
  expect(
    (
      await pool.query(
        "SELECT status,attempt FROM ingestion_runs WHERE id=$1",
        [id],
      )
    ).rows[0],
  ).toEqual({ status: "succeeded", attempt: 2 });
});

it("paginates recent runs and rejects malformed cursors", async () => {
  await ingest();
  await ingest();
  const app = await buildApp(pool, sources, "development-only-change-me");
  try {
    const first = (await app.inject("/v1/runs?limit=1")).json();
    expect(first.items).toHaveLength(1);
    const second = await app.inject(
      `/v1/runs?limit=1&cursor=${first.nextCursor}`,
    );
    expect(second.statusCode).toBe(200);
    expect(second.json().items[0].id).not.toBe(first.items[0].id);
    expect((await app.inject("/v1/runs?cursor=not-a-cursor")).statusCode).toBe(
      400,
    );
  } finally {
    await app.close();
  }
});

it("returns consistent run/attempt snapshots while a worker updates them", async () => {
  const { transaction } = await import("../../src/shared/database.js");
  const { id } = await createRun(pool, sources[0]!, "manual");
  const app = await buildApp(pool, sources, "development-only-change-me");
  const writer = (async () => {
    for (let attempt = 1; attempt <= 20; attempt++)
      await transaction(pool, async (client) => {
        await client.query(
          "UPDATE ingestion_runs SET attempt=$2,status='running' WHERE id=$1",
          [id, attempt],
        );
        await client.query(
          "INSERT INTO ingestion_attempts(run_id,attempt) VALUES($1,$2)",
          [id, attempt],
        );
      });
  })();
  try {
    for (let i = 0; i < 30; i++) {
      const response = await app.inject(`/v1/runs/${id}`);
      expect(response.statusCode).toBe(200);
      const detail = response.json();
      expect(detail.attempts.length).toBe(detail.attempt);
      if (detail.status === "queued") expect(detail.attempts).toEqual([]);
    }
  } finally {
    await writer;
    await app.close();
  }
});

it("bounds API bursts and returns safe client errors without URL reflection", async () => {
  const app = await buildApp(pool, sources, "development-only-change-me");
  try {
    for (const [payload, type, status] of [
      ["{", "application/json", 400],
      [JSON.stringify({ x: "x".repeat(17000) }), "application/json", 413],
      ["<x/>", "application/xml", 415],
    ] as const) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/sources/structured/runs",
        headers: { "content-type": type },
        payload,
      });
      expect(response.statusCode).toBe(status);
      expect(response.json().code).toBe("INVALID_REQUEST");
    }
    const missing = await app.inject("/unknown?token=secret-sentinel");
    expect(missing.statusCode).toBe(404);
    expect(missing.body).not.toContain("secret-sentinel");
    const responses = [];
    for (let i = 0; i < 120; i++)
      responses.push((await app.inject("/v1/products")).statusCode);
    expect(responses).toContain(200);
    expect(responses.every((status) => status === 200 || status === 429)).toBe(
      true,
    );
    expect((await app.inject("/v1/products")).statusCode).toBe(429);
  } finally {
    await app.close();
  }
});
it("bounds trigger attempts independently and rejects out-of-range history cursors", async () => {
  const app = await buildApp(pool, sources, "development-only-change-me");
  try {
    for (let i = 0; i < 10; i++)
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/v1/sources/structured/runs",
            payload: {},
          })
        ).statusCode,
      ).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/sources/structured/runs",
          payload: {},
        })
      ).statusCode,
    ).toBe(429);
    const response = await app.inject(
      "/v1/variants/00000000-0000-4000-8000-000000000000/history?cursor=9999999999999999999",
    );
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("INVALID_REQUEST");
  } finally {
    await app.close();
  }
});

it("runs ingestion as a non-owner role while denying schema and migration changes", async () => {
  const { grantRuntimeDatabase } =
    await import("../../src/shared/runtime-database.js");
  await pool.query(
    "CREATE ROLE ingestion_security_test NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS",
  );
  let runtime: ReturnType<typeof createPool> | undefined;
  try {
    await grantRuntimeDatabase(pool, "ingestion_security_test");
    runtime = createPool(url!);
    runtime.on("connect", (client) => {
      void client.query("SET ROLE ingestion_security_test");
    });
    expect(
      (await runtime.query("SELECT current_user AS role")).rows[0].role,
    ).toBe("ingestion_security_test");
    await expect(
      runtime.query("CREATE TABLE forbidden_security_test(id int)"),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      runtime.query("UPDATE app_migrations SET name=name"),
    ).rejects.toMatchObject({ code: "42501" });
    const { id } = await createRun(runtime, sources[0]!, "manual");
    await executeRun(runtime, id, browser);
    expect(
      (
        await runtime.query("SELECT status FROM ingestion_runs WHERE id=$1", [
          id,
        ])
      ).rows[0].status,
    ).toBe("succeeded");
    expect((await runtime.query("SELECT * FROM offer_history")).rowCount).toBe(
      1,
    );
  } finally {
    await runtime?.end();
    const tables = await pool.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='graphile_worker' AND rowsecurity",
    );
    for (const { tablename } of tables.rows)
      await pool.query(
        `DROP POLICY IF EXISTS runtime_service ON graphile_worker."${tablename.replaceAll('"', '""')}"`,
      );
    await pool.query("DROP OWNED BY ingestion_security_test");
    await pool.query("DROP ROLE ingestion_security_test");
  }
});

it("rolls back a page that exhausts its run deadline during database writes", async () => {
  await pool.query(
    "CREATE FUNCTION security_slow_product() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.65); RETURN NEW; END $$",
  );
  await pool.query(
    "CREATE TRIGGER security_slow_product BEFORE INSERT ON products FOR EACH ROW EXECUTE FUNCTION security_slow_product()",
  );
  try {
    const source = {
      ...sources[0]!,
      limits: { ...sources[0]!.limits, runTimeoutMs: 1000 },
    };
    const products = ["one", "two"].map((productID) => ({
      "@type": "Product",
      productID,
      name: "Deadline",
      offers: { price: "1", availability: "InStock" },
    }));
    fixture.states.set("structured", {
      html: `<script type="application/ld+json">${JSON.stringify(products)}</script>`,
    });
    const { id } = await createRun(pool, source, "manual");
    await executeRun(pool, id, browser);
    const result = (
      await pool.query(
        "SELECT status,error_code,finished_at>deadline AS late FROM ingestion_runs WHERE id=$1",
        [id],
      )
    ).rows[0];
    expect(result).toMatchObject({
      status: "failed",
      error_code: "RUN_DEADLINE",
    });
    expect((await pool.query("SELECT * FROM products")).rowCount).toBe(0);
    expect((await pool.query("SELECT * FROM offer_history")).rowCount).toBe(0);
  } finally {
    await pool.query("DROP TRIGGER security_slow_product ON products");
    await pool.query("DROP FUNCTION security_slow_product()");
  }
}, 10000);

it("persists delimiter identities and SQL-looking data while rejecting malformed Unicode", async () => {
  const entries = [
    ["a:b", "c"],
    ["a", "b:c"],
    ["x'); DROP TABLE products; --", "default"],
    ["bad\u0000id", "default"],
    ["bad\ud800id", "default"],
  ];
  const products = entries.map(([productID, sku]) => ({
    "@type": "Product",
    productID,
    name: "安全 😀",
    offers: { sku, price: "1", availability: "InStock" },
  }));
  fixture.states.set("structured", {
    html: `<script type="application/ld+json">${JSON.stringify(products)}</script>`,
  });
  const id = await ingest();
  expect(
    (
      await pool.query(
        "SELECT status,accepted,rejected,attempt FROM ingestion_runs WHERE id=$1",
        [id],
      )
    ).rows[0],
  ).toEqual({ status: "partial", accepted: 3, rejected: 2, attempt: 1 });
  expect((await pool.query("SELECT * FROM products")).rowCount).toBe(3);
  expect((await pool.query("SELECT * FROM variants")).rowCount).toBe(3);
  expect((await pool.query("SELECT * FROM offer_history")).rowCount).toBe(3);
});

it("initializes configured sources and queues a run before any worker starts", async () => {
  await pool.query("TRUNCATE sources CASCADE");
  const app = await buildApp(pool, sources, "development-only-change-me");
  try {
    expect((await app.inject("/health/ready")).statusCode).toBe(200);
    const response = await app.inject({
      method: "POST",
      url: "/v1/sources/structured/runs",
      headers: { authorization: "Bearer development-only-change-me" },
      payload: {},
    });
    expect(response.statusCode).toBe(202);
    const detail = (await app.inject(`/v1/runs/${response.json().id}`)).json();
    expect(detail.status).toBe("queued");
    expect(detail.attempt).toBe(0);
    expect(detail.attempts).toEqual([]);
    expect(
      (
        await pool.query("SELECT 1 FROM graphile_worker.jobs WHERE key=$1", [
          `${detail.id}:1`,
        ])
      ).rowCount,
    ).toBe(1);
    expect((await pool.query("SELECT id FROM sources")).rowCount).toBe(3);
  } finally {
    await app.close();
  }
});
