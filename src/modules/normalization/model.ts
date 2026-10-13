import { Type, type Static } from "@sinclair/typebox";
import { validate } from "../../config/validation.js";
import type { Source } from "../../config/sources.js";
export type Candidate = {
  id?: unknown;
  title?: unknown;
  price?: unknown;
  currency?: unknown;
  availability?: unknown;
  variantKey?: unknown;
  attributes?: unknown;
};
export const OfferSchema = Type.Object(
  {
    externalKey: Type.String({ minLength: 1, maxLength: 200 }),
    title: Type.String({ minLength: 1, maxLength: 500 }),
    url: Type.String({ format: "uri", maxLength: 2048 }),
    variantKey: Type.String({ minLength: 1, maxLength: 200 }),
    attributes: Type.Record(
      Type.String({ maxLength: 50 }),
      Type.String({ maxLength: 100 }),
      { maxProperties: 10 },
    ),
    price: Type.String({ pattern: "^(0|[1-9][0-9]{0,13})\\.[0-9]{6}$" }),
    currency: Type.String({ pattern: "^[A-Z]{3}$" }),
    availability: Type.Union([
      Type.Literal("in_stock"),
      Type.Literal("out_of_stock"),
      Type.Literal("preorder"),
      Type.Literal("unknown"),
    ]),
  },
  { additionalProperties: false },
);
export type Offer = Static<typeof OfferSchema>;
const currencies = new Set(["USD", "EUR", "GBP"]);
export function decimal(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number")
    throw new Error("Invalid price");
  const input = String(value)
    .trim()
    .replace(/^(?:USD|EUR|GBP|\$|€|£)\s*/, "");
  if (!/^(0|[1-9]\d{0,13})(\.\d{1,6})?$/.test(input))
    throw new Error("Invalid price");
  const [whole, fraction = ""] = input.split(".");
  return `${whole}.${fraction.padEnd(6, "0")}`;
}
export function availability(value: unknown): Offer["availability"] {
  if (typeof value !== "string") throw new Error("Missing availability");
  switch (
    value
      .trim()
      .replace(/^https?:\/\/schema.org\//, "")
      .toLowerCase()
  ) {
    case "instock":
    case "in stock":
    case "in_stock":
      return "in_stock";
    case "outofstock":
    case "out of stock":
    case "out_of_stock":
      return "out_of_stock";
    case "preorder":
      return "preorder";
    case "unknown":
      return "unknown";
    default:
      throw new Error("Invalid availability");
  }
}
export function normalize(
  candidate: Candidate,
  source: Source,
  url: string,
): Offer {
  const currency = candidate.currency ?? source.currency;
  if (typeof currency !== "string" || !currencies.has(currency))
    throw new Error("Unsupported currency");
  const offer = validate(OfferSchema, {
    externalKey: candidate.id,
    title:
      typeof candidate.title === "string"
        ? candidate.title.trim()
        : candidate.title,
    url,
    variantKey: candidate.variantKey ?? "default",
    attributes: candidate.attributes ?? {},
    price: decimal(candidate.price),
    currency,
    availability: availability(candidate.availability),
  });
  for (const text of [
    offer.externalKey,
    offer.title,
    offer.url,
    offer.variantKey,
    ...Object.entries(offer.attributes).flat(),
  ]) {
    if (text.includes("\u0000") || /[\uD800-\uDFFF]/u.test(text))
      throw new Error("Invalid Unicode text");
  }
  return offer;
}
