import { chromium } from "playwright";
import { readFileSync, readlinkSync } from "node:fs";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function assertSandboxEvidence(evidence) {
  assert(
    evidence && evidence.browser && evidence.renderers?.length,
    "Missing sandbox evidence",
  );
  const { browser, renderers } = evidence;
  for (const process of [browser, ...renderers]) {
    assert(process.uid > 0, "Browser processes must be non-root");
    assert.equal(process.capabilities, "0000000000000000");
    assert.equal(process.noNewPrivileges, 1);
    assert.equal(process.seccomp, 2);
    assert(Number.isInteger(process.filters) && process.filters > 0);
    assert(Array.isArray(process.args) && process.args.length > 0);
    assert(
      !process.args.some((arg) =>
        /^(--no-sandbox|--disable-setuid-sandbox|--disable-namespace-sandbox|--disable-seccomp-filter-sandbox|--single-process|--no-zygote)(=|$)/.test(
          arg,
        ),
      ),
      "Sandbox bypass argument",
    );
    for (const namespace of ["user", "pid", "net"])
      assert(
        /^\w+:\[\d+\]$/.test(process.namespaces?.[namespace] ?? ""),
        "Missing namespace evidence",
      );
  }
  for (const renderer of renderers) {
    assert(
      renderer.filters > browser.filters,
      "No additional Chromium seccomp filter",
    );
    for (const namespace of ["user", "pid", "net"])
      assert.notEqual(
        renderer.namespaces[namespace],
        browser.namespaces[namespace],
        "Renderer namespace was not isolated",
      );
  }
}
function processEvidence(pid) {
  assert(Number.isInteger(pid) && pid > 0);
  const status = Object.fromEntries(
    readFileSync(`/proc/${pid}/status`, "utf8")
      .split("\n")
      .filter((line) => line.includes(":"))
      .map((line) => {
        const index = line.indexOf(":");
        return [line.slice(0, index), line.slice(index + 1).trim()];
      }),
  );
  return {
    uid: Number(status.Uid?.split(/\s+/)[0]),
    capabilities: status.CapEff,
    noNewPrivileges: Number(status.NoNewPrivs),
    seccomp: Number(status.Seccomp),
    filters: Number(status.Seccomp_filters),
    args: readFileSync(`/proc/${pid}/cmdline`, "utf8")
      .split("\0")
      .filter(Boolean),
    namespaces: Object.fromEntries(
      ["user", "pid", "net"].map((name) => [
        name,
        readlinkSync(`/proc/${pid}/ns/${name}`),
      ]),
    ),
  };
}
async function check(mode) {
  let server;
  let browser;
  try {
    if (mode === "server") {
      server = await chromium.launchServer({
        chromiumSandbox: true,
        host: "127.0.0.1",
      });
      browser = await chromium.connect(server.wsEndpoint());
    } else browser = await chromium.launch({ chromiumSandbox: true });
    const page = await browser.newPage();
    await page.setContent("<p>Owned sandbox verification fixture</p>");
    const session = await browser.newBrowserCDPSession();
    const { processInfo } = await session.send("SystemInfo.getProcessInfo");
    const parent = processInfo.find((process) => process.type === "browser");
    assert(parent, "Missing browser PID");
    const evidence = {
      browser: processEvidence(parent.id),
      renderers: processInfo
        .filter((process) => process.type === "renderer")
        .map((process) => processEvidence(process.id)),
    };
    assertSandboxEvidence(evidence);
    // Output bounded security metadata, never environment or full command lines.
    process.stdout.write(
      JSON.stringify({
        mode,
        uid: evidence.browser.uid,
        browserFilters: evidence.browser.filters,
        renderers: evidence.renderers.map(({ namespaces, filters }) => ({
          namespaces,
          filters,
        })),
      }) + "\n",
    );
  } finally {
    try {
      await browser?.close();
    } finally {
      await server?.close();
    }
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    assert.equal(process.platform, "linux");
    assert(process.getuid() > 0, "CI verification requires non-root execution");
    await check("local");
    await check("server");
  } catch (error) {
    process.stderr.write(`Sandbox verification failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
