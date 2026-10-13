import { loadBoundedHtml } from "./html.js";
import type { Source } from "../../config/sources.js";
import {
  normalize,
  decimal,
  availability,
  type Candidate,
  type Offer,
} from "../normalization/model.js";
import { AppError } from "../../shared/errors.js";
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function jsonLd(html: string, maxItems = 500): Candidate[] {
  const $ = loadBoundedHtml(html);
  const scripts = $('script[type="application/ld+json"]');
  if (scripts.length > 20) throw new AppError("JSONLD_LIMIT");
  const result: Candidate[] = [];
  let nodes = 0;
  function walk(value: unknown, depth: number) {
    if (++nodes > 5000 || depth > 12) throw new AppError("JSONLD_LIMIT");
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    if (!object(value)) return;
    const type = value["@type"];
    if (
      type === "Product" ||
      (Array.isArray(type) && type.includes("Product"))
    ) {
      const offers = Array.isArray(value.offers)
        ? value.offers
        : [value.offers];
      for (const offer of offers) {
        if (!object(offer) || offer["@type"] === "AggregateOffer") continue;
        const variant = offer.sku;
        result.push({
          id: value.productID ?? value.sku ?? value["@id"],
          title: value.name,
          price: offer.price,
          currency: offer.priceCurrency,
          availability: offer.availability,
          ...(variant ? { variantKey: variant } : {}),
        });
        if (result.length > maxItems) throw new AppError("ITEM_LIMIT");
      }
    }
    if (value["@graph"]) walk(value["@graph"], depth + 1);
    if (value.itemListElement) walk(value.itemListElement, depth + 1);
    if (value.item) walk(value.item, depth + 1);
  }
  scripts.each((_i, script) => {
    const raw = $(script).text();
    if (raw.length > 262144) throw new AppError("JSONLD_LIMIT");
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return;
    }
    walk(value, 0);
  });
  return result;
}
export function dom(html: string, source: Source): Candidate[] {
  const $ = loadBoundedHtml(html);
  const items = $(source.extraction.itemSelector);
  if (items.length > source.limits.maxItems) throw new AppError("ITEM_LIMIT");
  return items.toArray().map((item) => {
    const record: Candidate = {};
    for (const key of ["id", "title", "price", "availability"] as const) {
      const field = source.extraction.fields[key];
      const node = $(item).is(field.selector)
        ? $(item)
        : $(item).find(field.selector).first();
      record[key] = field.attribute
        ? node.attr(field.attribute)
        : node.text().trim();
    }
    return record;
  });
}
export function extract(
  html: string,
  source: Source,
  url: string,
): { offers: Offer[]; rejected: number; extractor: string; next?: string } {
  const structured = source.extraction.jsonLd
    ? jsonLd(html, source.limits.maxItems)
    : [];
  const selected = dom(html, source);
  const records = new Map<string | symbol, Candidate>();
  for (const c of [...structured, ...selected]) {
    const key =
      typeof c.id === "string" && c.id
        ? JSON.stringify([c.id, c.variantKey ?? "default"])
        : Symbol("invalid");
    const previous = records.get(key);
    if (!previous) {
      records.set(key, c);
      continue;
    }
    const merged = { ...c, ...previous };
    for (const field of ["price", "availability"] as const) {
      const check = field === "price" ? decimal : availability;
      try {
        check(merged[field]);
      } catch {
        try {
          check(c[field]);
          merged[field] = c[field];
        } catch {
          /* Final validation rejects missing data. */
        }
      }
    }
    for (const field of ["title", "id"] as const) {
      if (!merged[field]) merged[field] = c[field];
    }
    records.set(key, merged);
  }
  const offers: Offer[] = [];
  let rejected = 0;
  for (const c of records.values()) {
    try {
      offers.push(normalize(c, source, url));
    } catch {
      rejected++;
    }
  }
  if (offers.length > source.limits.maxItems) throw new AppError("ITEM_LIMIT");
  const $ = loadBoundedHtml(html);
  const href = source.extraction.nextSelector
    ? $(source.extraction.nextSelector).first().attr("href")
    : undefined;
  let next: string | undefined;
  if (href) {
    if (href.length > 2048) throw new AppError("URL_REJECTED");
    try {
      next = new URL(href, url).href;
    } catch {
      throw new AppError("URL_REJECTED");
    }
  }
  return {
    offers,
    rejected,
    extractor: structured.length ? "jsonld" : "dom",
    ...(next ? { next } : {}),
  };
}
