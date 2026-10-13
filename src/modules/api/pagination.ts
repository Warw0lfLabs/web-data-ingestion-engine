import { Type } from "@sinclair/typebox";
import { validate } from "../../config/validation.js";
import { AppError } from "../../shared/errors.js";
const schema = Type.Object(
  {
    createdAt: Type.String({ format: "date-time" }),
    id: Type.String({ format: "uuid" }),
  },
  { additionalProperties: false },
);
export function runCursor(row: { created_at: Date; id: string }) {
  return Buffer.from(
    JSON.stringify({ createdAt: row.created_at.toISOString(), id: row.id }),
  ).toString("base64url");
}
export function parseRunCursor(value?: string) {
  if (!value) return undefined;
  try {
    if (value.length > 200 || !/^[A-Za-z0-9_-]+$/.test(value))
      throw new Error("Invalid cursor");
    return validate(
      schema,
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
  } catch {
    throw new AppError("INVALID_CURSOR");
  }
}
