import { MIMEType } from "node:util";
import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import { Agent, request } from "undici";
import type { Source } from "../../config/sources.js";
import { AppError } from "../../shared/errors.js";
export type Resolver = (
  hostname: string,
) => Promise<{ address: string; family: number }[]>;
const resolve: Resolver = (hostname) => lookup(hostname, { all: true });
export function publicAddress(value: string) {
  try {
    return ipaddr.process(value).range() === "unicast";
  } catch {
    return false;
  }
}
export function permittedUrl(value: string, source: Source): URL {
  if (value.length > 2048) throw new AppError("URL_REJECTED");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError("URL_REJECTED");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.origin !== source.allowedOrigin ||
    !(
      url.pathname === source.allowedPathPrefix ||
      url.pathname.startsWith(source.allowedPathPrefix + "/")
    ) ||
    /%(?:25|2f|5c|00)/i.test(url.pathname)
  )
    throw new AppError("URL_REJECTED");
  url.hash = "";
  return url;
}
export async function checkedAddresses(
  url: URL,
  source: Source,
  resolver: Resolver = resolve,
) {
  let addresses: Awaited<ReturnType<Resolver>>;
  try {
    addresses = await resolver(url.hostname.replace(/^\[|\]$/g, ""));
  } catch {
    throw new AppError("DNS_ERROR", true);
  }
  if (
    !addresses.length ||
    (source.networkPolicy === "public" &&
      addresses.some((a) => !publicAddress(a.address)))
  )
    throw new AppError("SSRF_REJECTED");
  return addresses;
}
export class Pacer {
  private next = 0;
  constructor(private intervalMs: number) {}
  async wait(signal?: AbortSignal) {
    const delay = Math.max(0, this.next - Date.now());
    this.next = Math.max(this.next, Date.now()) + this.intervalMs;
    if (delay)
      await new Promise<void>((res, rej) => {
        const abort = () => {
          clearTimeout(timer);
          rej(new AppError("TIMEOUT", true));
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", abort);
          res();
        }, delay);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      });
  }
}
export function retryAfter(value: string | undefined): number | undefined {
  if (!value) return;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(value) - Date.now();
  return Number.isFinite(delay) ? Math.max(0, delay) : undefined;
}
export async function fetchResource(
  value: string,
  source: Source,
  pacer: Pacer,
  runSignal?: AbortSignal,
  resolver: Resolver = resolve,
): Promise<{ body: Buffer; contentType: string; url: string }> {
  let url = permittedUrl(value, source);
  const signal = runSignal
    ? AbortSignal.any([
        runSignal,
        AbortSignal.timeout(source.limits.httpTimeoutMs),
      ])
    : AbortSignal.timeout(source.limits.httpTimeoutMs);
  for (let redirect = 0; redirect <= 3; redirect++) {
    await pacer.wait(signal);
    const addresses = await abortable(
      checkedAddresses(url, source, resolver),
      signal,
    );
    const pinned = addresses[0]!;
    const agent = new Agent({
      connect: {
        lookup: (_host, options, callback) => {
          if (options.all) callback(null, [pinned]);
          else callback(null, pinned.address, pinned.family);
        },
      },
    });
    try {
      const response = await request(url, {
        dispatcher: agent,
        signal,
        headersTimeout: source.limits.httpTimeoutMs,
        bodyTimeout: source.limits.httpTimeoutMs,
        headers: {
          "user-agent": "WebDataIngestionDemo/0.1",
          accept: "text/html",
          "accept-encoding": "identity",
        },
      });
      // Deliberately abort rejected bodies; consume their expected stream error.
      response.body.on("error", () => {});
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.body.destroy();
        const location = response.headers.location;
        if (redirect === 3 || typeof location !== "string")
          throw new AppError("REDIRECT_LIMIT");
        url = permittedUrl(new URL(location, url).href, source);
        continue;
      }
      if (response.statusCode !== 200) {
        response.body.destroy();
        const retryable =
          response.statusCode === 429 ||
          [500, 502, 503, 504].includes(response.statusCode);
        throw new AppError(
          `HTTP_${response.statusCode}`,
          retryable,
          retryAfter(
            typeof response.headers["retry-after"] === "string"
              ? response.headers["retry-after"]
              : undefined,
          ),
        );
      }
      const encoding = response.headers["content-encoding"];
      if (encoding && encoding !== "identity") {
        response.body.destroy();
        throw new AppError("UNSUPPORTED_ENCODING");
      }
      const contentType = response.headers["content-type"];
      if (
        typeof contentType !== "string" ||
        !/^(text\/(html|css)|application\/(javascript|json)|text\/javascript)(?:;|$)/i.test(
          contentType,
        )
      ) {
        response.body.destroy();
        throw new AppError("CONTENT_TYPE_REJECTED");
      }
      const charset = new MIMEType(contentType).params
        .get("charset")
        ?.toLowerCase();
      if (charset && !["utf-8", "utf8"].includes(charset)) {
        response.body.destroy();
        throw new AppError("UNSUPPORTED_CHARSET");
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response.body) {
        const buffer = Buffer.from(chunk);
        size += buffer.length;
        if (size > source.limits.maxBytes) {
          response.body.destroy();
          throw new AppError("RESPONSE_TOO_LARGE");
        }
        chunks.push(buffer);
      }
      const body = Buffer.concat(chunks);
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(body);
      } catch {
        throw new AppError("INVALID_TEXT_ENCODING");
      }
      return { body, contentType, url: url.href };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(signal.aborted ? "TIMEOUT" : "NETWORK_ERROR", true);
    } finally {
      await agent.close();
    }
  }
  throw new AppError("REDIRECT_LIMIT");
}

export async function fetchHtml(
  value: string,
  source: Source,
  pacer: Pacer,
  signal?: AbortSignal,
  resolver: Resolver = resolve,
) {
  const result = await fetchResource(value, source, pacer, signal, resolver);
  if (!/^text\/html(?:;|$)/i.test(result.contentType))
    throw new AppError("CONTENT_TYPE_REJECTED");
  return { html: result.body.toString("utf8"), url: result.url };
}

/** Bounds asynchronous DNS resolution without leaving signal listeners behind. */
async function abortable<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new AppError("TIMEOUT", true));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    operation
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
const pacers = new Map<string, Pacer>();
export function sourcePacer(source: Source): Pacer {
  const key = `${source.id}:${source.allowedOrigin}:${source.limits.intervalMs}`;
  let pacer = pacers.get(key);
  if (!pacer) {
    pacer = new Pacer(source.limits.intervalMs);
    pacers.set(key, pacer);
  }
  return pacer;
}
