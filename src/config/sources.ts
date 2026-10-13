import { Type, type Static } from "@sinclair/typebox";
import { createHash } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import { validate } from "./validation.js";
import { permittedUrl } from "../modules/network/http.js";
const field = Type.Object(
  {
    selector: Type.String({ minLength: 1, maxLength: 200 }),
    attribute: Type.Optional(Type.String({ maxLength: 80 })),
  },
  { additionalProperties: false },
);
export const SourceSchema = Type.Object(
  {
    id: Type.String({ pattern: "^[a-z][a-z0-9-]{0,63}$" }),
    name: Type.String({ minLength: 1, maxLength: 100 }),
    enabled: Type.Boolean(),
    permission: Type.String({ minLength: 1, maxLength: 500 }),
    startUrls: Type.Array(Type.String({ format: "uri", maxLength: 2048 }), {
      minItems: 1,
      maxItems: 10,
    }),
    allowedOrigin: Type.String({ format: "uri", maxLength: 2048 }),
    allowedPathPrefix: Type.String({ pattern: "^/", maxLength: 200 }),
    networkPolicy: Type.Union([
      Type.Literal("fixture"),
      Type.Literal("public"),
    ]),
    cron: Type.String({ maxLength: 100 }),
    extraction: Type.Object(
      {
        jsonLd: Type.Boolean(),
        itemSelector: Type.String({ maxLength: 200 }),
        fields: Type.Object({
          id: field,
          title: field,
          price: field,
          availability: field,
        }),
        nextSelector: Type.Optional(Type.String({ maxLength: 200 })),
        browser: Type.Object(
          {
            enabled: Type.Boolean(),
            readySelector: Type.String({ maxLength: 200 }),
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
    currency: Type.String({ pattern: "^[A-Z]{3}$" }),
    limits: Type.Object(
      {
        maxPages: Type.Integer({ minimum: 1, maximum: 20 }),
        maxItems: Type.Integer({ minimum: 1, maximum: 500 }),
        intervalMs: Type.Integer({ minimum: 10, maximum: 60000 }),
        httpTimeoutMs: Type.Integer({ minimum: 100, maximum: 15000 }),
        maxBytes: Type.Integer({ minimum: 100, maximum: 2097152 }),
        browserTimeoutMs: Type.Integer({ minimum: 100, maximum: 30000 }),
        runTimeoutMs: Type.Integer({ minimum: 1000, maximum: 600000 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type Source = Static<typeof SourceSchema>;
export function sourceHash(source: Source) {
  return createHash("sha256").update(JSON.stringify(source)).digest("hex");
}
export function validateSource(input: unknown): Source {
  const s = validate(SourceSchema, input);
  const origin = new URL(s.allowedOrigin);
  if (origin.origin !== s.allowedOrigin || origin.username || origin.password)
    throw new Error("Invalid allowed origin");
  if (
    s.networkPolicy === "public" &&
    (origin.protocol !== "https:" || s.extraction.browser.enabled)
  )
    throw new Error("Public sources require HTTPS and cannot use browsers");
  if (
    s.networkPolicy === "fixture" &&
    !["127.0.0.1", "localhost", "fixture-server"].includes(origin.hostname)
  )
    throw new Error("Fixture host must be explicit");
  for (const value of s.startUrls) permittedUrl(value, s);
  for (const field of Object.values(s.extraction.fields)) {
    if (!field.selector.trim()) throw new Error("Empty selector");
  }
  CronExpressionParser.parse(s.cron, { tz: "UTC" });
  return s;
}
export function demoSources(origin: string): Source[] {
  return ["structured", "dom", "javascript"].map((id) =>
    validateSource({
      id,
      name: `${id} demonstration`,
      enabled: true,
      permission: "Owned deterministic local fixture; docs/source-policy.md",
      startUrls: [`${origin}/${id}`],
      allowedOrigin: origin,
      allowedPathPrefix: `/${id}`,
      networkPolicy: "fixture",
      cron: "0 */6 * * *",
      extraction: {
        jsonLd: true,
        itemSelector: ".product",
        fields: {
          id: { selector: ".product", attribute: "data-id" },
          title: { selector: ".title" },
          price: { selector: ".price" },
          availability: { selector: ".stock" },
        },
        nextSelector: "a.next",
        browser: { enabled: id === "javascript", readySelector: ".product" },
      },
      currency: "USD",
      limits: {
        maxPages: 20,
        maxItems: 500,
        intervalMs: 1000,
        httpTimeoutMs: 15000,
        maxBytes: 2097152,
        browserTimeoutMs: 30000,
        runTimeoutMs: 600000,
      },
    }),
  );
}

/** Source files are operator-controlled; API requests cannot alter this path. */
export async function loadSources(
  fixtureOrigin: string,
  path = process.env.SOURCE_CONFIG_PATH ?? "config/sources.json",
): Promise<Source[]> {
  const { readFile } = await import("node:fs/promises");
  const bytes = await readFile(path);
  if (bytes.length > 65536) throw new Error("Source configuration too large");
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  if (!Array.isArray(value) || value.length < 1 || value.length > 10)
    throw new Error("Expected 1–10 sources");
  const sources = value.map((raw) => {
    const source = validateSource(raw);
    if (source.networkPolicy !== "fixture") return source;
    const oldOrigin = source.allowedOrigin;
    return validateSource({
      ...source,
      allowedOrigin: fixtureOrigin,
      startUrls: source.startUrls.map((url) =>
        url.replace(oldOrigin, fixtureOrigin),
      ),
    });
  });
  if (new Set(sources.map((s) => s.id)).size !== sources.length)
    throw new Error("Duplicate source IDs");
  return sources;
}
