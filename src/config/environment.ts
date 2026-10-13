import { Type } from "@sinclair/typebox";
import { validate } from "./validation.js";
const schema = Type.Object(
  {
    databaseUrl: Type.String({ minLength: 1, maxLength: 2048 }),
    port: Type.Integer({ minimum: 1, maximum: 65535 }),
    fixtureOrigin: Type.String({ format: "uri", maxLength: 2048 }),
    browserEndpoint: Type.Optional(
      Type.String({ format: "uri", maxLength: 2048 }),
    ),
    apiToken: Type.String({ minLength: 16, maxLength: 256 }),
  },
  { additionalProperties: false },
);
export function environment() {
  return validate(schema, {
    databaseUrl: process.env.DATABASE_URL,
    port: Number(process.env.PORT ?? 3000),
    fixtureOrigin: process.env.FIXTURE_ORIGIN ?? "http://127.0.0.1:8080",
    ...(process.env.BROWSER_ENDPOINT
      ? { browserEndpoint: process.env.BROWSER_ENDPOINT }
      : {}),
    apiToken: process.env.API_TOKEN,
  });
}
