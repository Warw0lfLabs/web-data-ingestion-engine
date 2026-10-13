import Ajv from "ajv";
import addFormats from "ajv-formats";
import type { Static, TSchema } from "@sinclair/typebox";
const ajv = new Ajv.default({ allErrors: true, strict: true });
addFormats.default(ajv);
export function validate<T extends TSchema>(
  schema: T,
  value: unknown,
): Static<T> {
  const check = ajv.compile(schema);
  if (!check(value))
    throw new Error("Configuration or input validation failed");
  return value as Static<T>;
}
