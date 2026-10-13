import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { demoSources, validateSource } from "../../src/config/sources.js";
import { extract, jsonLd } from "../../src/modules/extraction/static.js";
import {
  decimal,
  availability,
} from "../../src/modules/normalization/model.js";
import { backoff } from "../../src/modules/jobs/runs.js";
import { latestOccurrence } from "../../src/modules/jobs/scheduler.js";
const sources = demoSources("http://127.0.0.1:8080");
describe("deterministic extraction", () => {
  it.each([
    ["structured", "book-1", "19.990000", "jsonld"],
    ["dom", "lamp-1", "29.500000", "dom"],
  ])("extracts %s", async (name, id, price, method) => {
    const html = await readFile(`tests/fixtures/html/${name}.html`, "utf8");
    const source = sources.find((s) => s.id === name)!;
    const result = extract(html, source, source.startUrls[0]!);
    expect(result.rejected).toBe(0);
    expect(result.extractor).toBe(method);
    expect(result.offers[0]).toMatchObject({
      externalKey: id,
      price,
      availability: "in_stock",
    });
  });
  it("requires browser for JS fixture", async () => {
    const html = await readFile("tests/fixtures/html/javascript.html", "utf8");
    expect(
      extract(html, sources[2]!, sources[2]!.startUrls[0]!).offers,
    ).toEqual([]);
  });
  it("ignores malformed JSON-LD and falls back to DOM", async () => {
    const html = await readFile("tests/fixtures/html/dom.html", "utf8");
    expect(
      extract(
        `<script type="application/ld+json">{bad</script>${html}`,
        sources[1]!,
        sources[1]!.startUrls[0]!,
      ).offers,
    ).toHaveLength(1);
  });
  it("supports graphs and offer variants", () => {
    const html =
      '<script type="application/ld+json">' +
      JSON.stringify({
        "@graph": [
          {
            "@type": "Product",
            productID: "p",
            name: "Variants",
            offers: [
              {
                "@type": "Offer",
                sku: "blue",
                price: "10",
                priceCurrency: "USD",
                availability: "https://schema.org/InStock",
              },
              {
                "@type": "Offer",
                sku: "red",
                price: "11",
                priceCurrency: "USD",
                availability: "https://schema.org/OutOfStock",
              },
            ],
          },
        ],
      }) +
      "</script>";
    const offers = extract(html, sources[0]!, sources[0]!.startUrls[0]!).offers;
    expect(offers.map((o) => o.variantKey)).toEqual(["blue", "red"]);
  });
  it("bounds JSON-LD nesting and candidates", () => {
    let nested: unknown = {};
    for (let i = 0; i < 20; i++) nested = { "@graph": nested };
    expect(() =>
      jsonLd(
        `<script type="application/ld+json">${JSON.stringify(nested)}</script>`,
      ),
    ).toThrow("JSONLD_LIMIT");
  });
  it("rejects malformed prices and availability without inventing values", () => {
    for (const value of ["-1", "NaN", "1,200", "1e9", "1.0000001"])
      expect(() => decimal(value)).toThrow();
    expect(decimal("0")).toBe("0.000000");
    expect(() => availability(undefined)).toThrow();
  });
  it("rejects unsafe browser/public source configuration", () => {
    expect(() =>
      validateSource({ ...sources[0], networkPolicy: "public" }),
    ).toThrow();
    expect(() =>
      validateSource({
        ...sources[0],
        allowedOrigin: "http://metadata.internal",
      }),
    ).toThrow();
  });
  it("caps retries and calculates UTC catch-up occurrence", () => {
    expect(backoff(1, () => 0)).toBe(2500);
    expect(backoff(20, () => 1)).toBe(60000);
    expect(
      latestOccurrence(
        "0 */6 * * *",
        new Date("2026-10-06T15:00:00Z"),
      ).toISOString(),
    ).toBe("2026-10-06T12:00:00.000Z");
  });
});

it("fills multiple invalid structured fields independently from matching DOM records", async () => {
  const html = await readFile("tests/fixtures/html/dom.html", "utf8");
  const script = `<script type="application/ld+json">${JSON.stringify({ "@type": "Product", productID: "lamp-1", name: "Structured title", offers: { "@type": "Offer", price: "bad", availability: "bad" } })}</script>`;
  const result = extract(script + html, sources[1]!, sources[1]!.startUrls[0]!);
  expect(result.offers).toHaveLength(1);
  expect(result.offers[0]).toMatchObject({
    title: "Structured title",
    price: "29.500000",
    availability: "in_stock",
  });
  expect(result.rejected).toBe(0);
});
it("keeps valid JSON-LD values ahead of conflicting DOM values", async () => {
  const html = await readFile("tests/fixtures/html/dom.html", "utf8");
  const script = `<script type="application/ld+json">${JSON.stringify({ "@type": "Product", productID: "lamp-1", name: "Structured title", offers: { "@type": "Offer", price: "9.00", priceCurrency: "USD", availability: "https://schema.org/OutOfStock" } })}</script>`;
  expect(
    extract(script + html, sources[1]!, sources[1]!.startUrls[0]!).offers[0],
  ).toMatchObject({ price: "9.000000", availability: "out_of_stock" });
});

it("preserves distinct product/variant pairs containing delimiters", () => {
  const products = [
    ["a:b", "c"],
    ["a", "b:c"],
  ].map(([productID, sku]) => ({
    "@type": "Product",
    productID,
    name: "Distinct",
    offers: { sku, price: "1", availability: "InStock" },
  }));
  const html = `<script type="application/ld+json">${JSON.stringify(products)}</script>`;
  expect(
    extract(html, sources[0]!, sources[0]!.startUrls[0]!).offers,
  ).toHaveLength(2);
});
it("rejects NUL and unpaired surrogates in extracted identifiers", () => {
  for (const productID of ["bad\u0000id", "bad\ud800id", "bad\udfffid"]) {
    const html = `<script type="application/ld+json">${JSON.stringify({ "@type": "Product", productID, name: "Invalid", offers: { price: "1", availability: "InStock" } })}</script>`;
    expect(extract(html, sources[0]!, sources[0]!.startUrls[0]!)).toMatchObject(
      { offers: [], rejected: 1 },
    );
  }
});

it("rejects hostile DOM depth, node counts and attribute counts before DOM construction", () => {
  for (const html of [
    "<div>".repeat(50000) + "</div>".repeat(50000),
    "<!--x-->".repeat(20001),
    "<div " +
      Array.from({ length: 101 }, (_, i) => `x${i}="x"`).join(" ") +
      "></div>",
  ]) {
    const start = Date.now();
    expect(() => extract(html, sources[1]!, sources[1]!.startUrls[0]!)).toThrow(
      "HTML_LIMIT",
    );
    expect(Date.now() - start).toBeLessThan(1000);
  }
});
