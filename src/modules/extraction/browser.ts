import { chromium, type Browser } from "playwright";
import type { Source } from "../../config/sources.js";
import { permittedUrl, sourcePacer, fetchResource } from "../network/http.js";
import { AppError } from "../../shared/errors.js";
export class BrowserExtractor {
  private tail: Promise<void> = Promise.resolve();
  constructor(private endpoint?: string) {}
  async html(
    url: string,
    source: Source,
    signal?: AbortSignal,
  ): Promise<string> {
    if (
      source.networkPolicy !== "fixture" ||
      !source.extraction.browser.enabled
    )
      throw new AppError("BROWSER_FORBIDDEN");
    permittedUrl(url, source);
    const deadline = Date.now() + source.limits.browserTimeoutMs;
    const budget = AbortSignal.timeout(source.limits.browserTimeoutMs);
    signal = signal ? AbortSignal.any([signal, budget]) : budget;
    const previous = this.tail;
    let release!: () => void;
    const slot = new Promise<void>((r) => {
      release = r;
    });
    this.tail = previous.then(() => slot);
    let browser: Browser | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(new AppError("BROWSER_TIMEOUT", true));
        signal!.addEventListener("abort", abort, { once: true });
        if (signal!.aborted) abort();
        previous
          .then(resolve, reject)
          .finally(() => signal!.removeEventListener("abort", abort));
      });
      if (signal?.aborted) throw new AppError("TIMEOUT", true);
      browser = this.endpoint
        ? await chromium.connect(this.endpoint, {
            timeout: Math.max(1, deadline - Date.now()),
          })
        : await chromium.launch({
            chromiumSandbox: true,
            timeout: Math.max(1, deadline - Date.now()),
          });
      const context = await browser.newContext({
        serviceWorkers: "block",
        acceptDownloads: false,
      });
      let closing: Promise<void> | undefined;
      const closeContext = () => (closing ??= context.close());
      const abort = () => {
        void closeContext().catch(() => {});
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      let requests = 0;
      let bytes = 0;
      let resourceTail: Promise<void> = Promise.resolve();
      let violation: string | undefined;
      const pacer = sourcePacer(source);
      try {
        await context.route("**/*", async (route) => {
          try {
            const req = route.request();
            permittedUrl(req.url(), source);
            if (++requests > 30) throw new AppError("BROWSER_REQUEST_LIMIT");
            if (
              !["document", "script", "stylesheet", "fetch", "xhr"].includes(
                req.resourceType(),
              )
            ) {
              await route.abort();
              return;
            }
            if (req.method() !== "GET")
              throw new AppError("BROWSER_METHOD_REJECTED");
            // Serialize downloads so concurrent scripts cannot each spend the
            // entire byte allowance before the cumulative check runs.
            const operation = resourceTail.then(async () => {
              if (bytes >= source.limits.maxBytes)
                throw new AppError("BROWSER_RESPONSE_LIMIT");
              const resource = await fetchResource(
                req.url(),
                {
                  ...source,
                  limits: {
                    ...source.limits,
                    maxBytes: source.limits.maxBytes - bytes,
                  },
                },
                pacer,
                signal,
              );
              bytes += resource.body.length;
              return resource;
            });
            resourceTail = operation.then(
              () => {},
              () => {},
            );
            const resource = await operation;
            await route.fulfill({
              status: 200,
              contentType: resource.contentType,
              body: resource.body,
            });
          } catch {
            violation = "BROWSER_NETWORK_REJECTED";
            await route.abort().catch(() => {});
          }
        });
        await context.routeWebSocket("**/*", (socket) => {
          violation = "BROWSER_WEBSOCKET_REJECTED";
          socket.close();
        });
        const page = await context.newPage();
        page.on("popup", (popup) => {
          violation = "BROWSER_POPUP_REJECTED";
          void popup.close();
        });
        page.on("download", (download) => {
          violation = "BROWSER_DOWNLOAD_REJECTED";
          void download.cancel();
        });
        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: Math.min(20000, source.limits.browserTimeoutMs),
        });
        await page.waitForSelector(source.extraction.browser.readySelector, {
          timeout: Math.max(1, deadline - Date.now()),
        });
        if (violation) throw new AppError(violation);
        const html = await page.content();
        if (Buffer.byteLength(html) > source.limits.maxBytes)
          throw new AppError("RESPONSE_TOO_LARGE");
        return html;
      } finally {
        signal?.removeEventListener("abort", abort);
        await closeContext();
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("BROWSER_TIMEOUT", true);
    } finally {
      try {
        await browser?.close();
      } finally {
        release();
      }
    }
  }
}
