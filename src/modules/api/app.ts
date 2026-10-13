import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { Type } from "@sinclair/typebox";
import { timingSafeEqual } from "node:crypto";
import type pg from "pg";
import type { Source } from "../../config/sources.js";
import { runCursor, parseRunCursor } from "./pagination.js";
import { transaction } from "../../shared/database.js";
import { createRun, syncSources } from "../jobs/runs.js";
import { AppError } from "../../shared/errors.js";
const errorResponse = Type.Object({
  code: Type.String(),
  requestId: Type.String(),
});
const id = Type.Object(
  { id: Type.String({ format: "uuid" }) },
  { additionalProperties: false },
);
const sourceId = Type.Object(
  { id: Type.String({ pattern: "^[a-z][a-z0-9-]{0,63}$", maxLength: 64 }) },
  { additionalProperties: false },
);
const pagination = {
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
  cursor: Type.Optional(Type.String({ format: "uuid" })),
};
function authorized(header: string | undefined, token: string) {
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(header ?? "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export async function buildApp(
  pool: pg.Pool,
  sources: Source[],
  token: string,
  logging = false,
) {
  // Manual triggers must queue successfully even before the worker starts.
  await syncSources(pool, sources);
  const app = Fastify({
    logger: logging
      ? {
          redact: ["req.headers.authorization", "req.headers.cookie"],
          serializers: {
            req: (req) => ({ method: req.method, url: req.url.split("?")[0] }),
          },
        }
      : false,
    ajv: { customOptions: { removeAdditional: false } },
    bodyLimit: 16384,
    requestTimeout: 10000,
  });
  await app.register(rateLimit, {
    max: 120,
    timeWindow: "1 minute",
    cache: 5000,
  });
  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send({ code: "NOT_FOUND", requestId: req.id }),
  );
  await app.register(swagger, {
    openapi: {
      info: { title: "Web Data Ingestion Engine", version: "0.1.0" },
      components: {
        securitySchemes: { triggerToken: { type: "http", scheme: "bearer" } },
      },
    },
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });
  app.setErrorHandler((error, _request, reply) => {
    const validation =
      typeof error === "object" && error !== null && "validation" in error;
    const clientStatus =
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number" &&
      error.statusCode >= 400 &&
      error.statusCode < 500
        ? error.statusCode
        : undefined;
    if (!(error instanceof AppError) && !validation && !clientStatus)
      app.log.error(
        { code: "INTERNAL_ERROR", requestId: _request.id },
        "Request failed",
      );
    const status = validation
      ? 400
      : error instanceof AppError
        ? error.code === "SOURCE_BUSY"
          ? 409
          : 400
        : (clientStatus ?? 500);
    reply.code(status).send({
      code: validation
        ? "INVALID_REQUEST"
        : error instanceof AppError
          ? error.code
          : clientStatus === 429
            ? "RATE_LIMITED"
            : clientStatus
              ? "INVALID_REQUEST"
              : "INTERNAL_ERROR",
      requestId: _request.id,
    });
  });
  app.get(
    "/health/live",
    { schema: { description: "Process liveness" } },
    async () => ({ status: "ok" }),
  );
  app.get("/health/ready", async (_req, reply) => {
    try {
      await pool.query("SELECT id FROM sources LIMIT 1");
      await pool.query("SELECT 1 FROM graphile_worker.jobs LIMIT 1");
      return { status: "ready" };
    } catch {
      reply.code(503);
      return { status: "unavailable" };
    }
  });
  app.get("/v1/sources", async () => ({
    items: sources.map((s) => ({
      id: s.id,
      name: s.name,
      enabled: s.enabled,
      schedule: s.cron,
      browserEnabled: s.extraction.browser.enabled,
    })),
  }));
  app.get<{ Params: { id: string } }>(
    "/v1/sources/:id",
    { schema: { params: sourceId } },
    async (req, reply) => {
      const source = sources.find((s) => s.id === req.params.id);
      if (!source)
        return reply.code(404).send({ code: "NOT_FOUND", requestId: req.id });
      const runs = await pool.query(
        "SELECT id,status,created_at,finished_at,accepted,rejected,error_code FROM ingestion_runs WHERE source_id=$1 ORDER BY created_at DESC LIMIT 5",
        [source.id],
      );
      return {
        id: source.id,
        name: source.name,
        enabled: source.enabled,
        schedule: source.cron,
        recentRuns: runs.rows,
      };
    },
  );
  app.post<{ Params: { id: string }; Headers: { "idempotency-key"?: string } }>(
    "/v1/sources/:id/runs",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        params: sourceId,
        body: Type.Object({}, { additionalProperties: false }),
        headers: Type.Object({
          "idempotency-key": Type.Optional(
            Type.String({ minLength: 1, maxLength: 128 }),
          ),
        }),
        security: [{ triggerToken: [] }],
        response: {
          202: Type.Object({
            id: Type.String({ format: "uuid" }),
            reused: Type.Boolean(),
          }),
          400: errorResponse,
          401: errorResponse,
          404: errorResponse,
          409: errorResponse,
          413: errorResponse,
          415: errorResponse,
          429: errorResponse,
          500: errorResponse,
        },
      },
    },
    async (req, reply) => {
      if (!authorized(req.headers.authorization, token))
        return reply
          .code(401)
          .send({ code: "UNAUTHORIZED", requestId: req.id });
      const source = sources.find((s) => s.id === req.params.id && s.enabled);
      if (!source)
        return reply.code(404).send({ code: "NOT_FOUND", requestId: req.id });
      const result = await createRun(pool, source, "manual", {
        idempotencyKey: req.headers["idempotency-key"],
      });
      return reply
        .code(202)
        .header("Location", `/v1/runs/${result.id}`)
        .send(result);
    },
  );
  app.get<{
    Querystring: {
      limit?: number;
      cursor?: string;
      source?: string;
      status?: string;
    };
  }>(
    "/v1/runs",
    {
      schema: {
        querystring: Type.Object(
          {
            ...pagination,
            cursor: Type.Optional(Type.String({ maxLength: 200 })),
            source: Type.Optional(
              Type.String({ pattern: "^[a-z][a-z0-9-]{0,63}$", maxLength: 64 }),
            ),
            status: Type.Optional(
              Type.Union(
                [
                  "queued",
                  "running",
                  "retrying",
                  "succeeded",
                  "partial",
                  "failed",
                ].map((v) => Type.Literal(v)),
              ),
            ),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (req) => {
      const limit = req.query.limit ?? 20;
      const cursor = parseRunCursor(req.query.cursor);
      const result = await pool.query<{ id: string; created_at: Date }>(
        "SELECT id,source_id,status,created_at,started_at,finished_at,attempt,accepted,rejected,changed,error_code FROM ingestion_runs WHERE ($1::text IS NULL OR source_id=$1) AND ($2::text IS NULL OR status=$2) AND ($3::timestamptz IS NULL OR (created_at,id)<($3::timestamptz,$4::uuid)) ORDER BY created_at DESC,id DESC LIMIT $5",
        [
          req.query.source ?? null,
          req.query.status ?? null,
          cursor?.createdAt ?? null,
          cursor?.id ?? null,
          limit + 1,
        ],
      );
      return {
        items: result.rows.slice(0, limit),
        nextCursor:
          result.rows.length > limit
            ? runCursor(result.rows[limit - 1]!)
            : null,
      };
    },
  );
  app.get<{ Params: { id: string } }>(
    "/v1/runs/:id",
    { schema: { params: id } },
    async (req, reply) =>
      transaction(pool, async (client) => {
        await client.query(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
        );
        const run = await client.query(
          "SELECT id,source_id,config_hash,trigger,status,created_at,started_at,finished_at,deadline,attempt,accepted,rejected,changed,error_code FROM ingestion_runs WHERE id=$1",
          [req.params.id],
        );
        if (!run.rowCount)
          return reply.code(404).send({ code: "NOT_FOUND", requestId: req.id });
        const [attempts, pages] = await Promise.all([
          client.query(
            "SELECT * FROM ingestion_attempts WHERE run_id=$1 ORDER BY attempt LIMIT 20",
            [req.params.id],
          ),
          client.query(
            "SELECT status,extractor,accepted,rejected,changed,error_code FROM ingestion_page_results WHERE run_id=$1 LIMIT 20",
            [req.params.id],
          ),
        ]);
        return { ...run.rows[0], attempts: attempts.rows, pages: pages.rows };
      }),
  );
  app.get<{
    Querystring: {
      limit?: number;
      cursor?: string;
      source?: string;
      availability?: string;
    };
  }>(
    "/v1/products",
    {
      schema: {
        querystring: Type.Object(
          {
            ...pagination,
            source: Type.Optional(
              Type.String({ pattern: "^[a-z][a-z0-9-]{0,63}$", maxLength: 64 }),
            ),
            availability: Type.Optional(
              Type.Union(
                ["in_stock", "out_of_stock", "preorder", "unknown"].map((v) =>
                  Type.Literal(v),
                ),
              ),
            ),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (req) => {
      const limit = req.query.limit ?? 20;
      const rows = await pool.query(
        "SELECT p.* FROM products p WHERE ($1::text IS NULL OR p.source_id=$1) AND ($2::uuid IS NULL OR p.id>$2) AND ($3::text IS NULL OR EXISTS(SELECT 1 FROM variants v JOIN offer_current o ON o.variant_id=v.id WHERE v.product_id=p.id AND o.availability=$3)) ORDER BY p.id LIMIT $4",
        [
          req.query.source ?? null,
          req.query.cursor ?? null,
          req.query.availability ?? null,
          limit + 1,
        ],
      );
      return {
        items: rows.rows.slice(0, limit),
        nextCursor: rows.rows.length > limit ? rows.rows[limit - 1]?.id : null,
      };
    },
  );
  app.get<{ Params: { id: string } }>(
    "/v1/products/:id",
    { schema: { params: id } },
    async (req, reply) => {
      const product = await pool.query("SELECT * FROM products WHERE id=$1", [
        req.params.id,
      ]);
      if (!product.rowCount)
        return reply.code(404).send({ code: "NOT_FOUND", requestId: req.id });
      const variants = await pool.query(
        "SELECT v.*,o.price,o.currency,o.availability,o.last_observed_at,o.last_changed_at FROM variants v LEFT JOIN offer_current o ON o.variant_id=v.id WHERE v.product_id=$1 ORDER BY v.id LIMIT 500",
        [req.params.id],
      );
      return { ...product.rows[0], variants: variants.rows };
    },
  );
  app.get<{
    Params: { id: string };
    Querystring: {
      limit?: number;
      cursor?: string;
      from?: string;
      to?: string;
    };
  }>(
    "/v1/variants/:id/history",
    {
      schema: {
        params: id,
        querystring: Type.Object(
          {
            limit: pagination.limit,
            cursor: Type.Optional(Type.String({ pattern: "^[0-9]{1,19}$" })),
            from: Type.Optional(
              Type.String({ format: "date-time", maxLength: 64 }),
            ),
            to: Type.Optional(
              Type.String({ format: "date-time", maxLength: 64 }),
            ),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (req, reply) => {
      if (req.query.cursor && BigInt(req.query.cursor) > 9223372036854775807n)
        throw new AppError("INVALID_REQUEST");
      if (
        !(
          await pool.query("SELECT 1 FROM variants WHERE id=$1", [
            req.params.id,
          ])
        ).rowCount
      )
        return reply.code(404).send({ code: "NOT_FOUND", requestId: req.id });
      const limit = req.query.limit ?? 20;
      const rows = await pool.query(
        "SELECT * FROM offer_history WHERE variant_id=$1 AND ($2::bigint IS NULL OR id>$2) AND ($3::timestamptz IS NULL OR observed_at>=$3) AND ($4::timestamptz IS NULL OR observed_at<=$4) ORDER BY id LIMIT $5",
        [
          req.params.id,
          req.query.cursor ?? null,
          req.query.from ?? null,
          req.query.to ?? null,
          limit + 1,
        ],
      );
      return {
        items: rows.rows.slice(0, limit),
        nextCursor: rows.rows.length > limit ? rows.rows[limit - 1]?.id : null,
      };
    },
  );
  return app;
}
