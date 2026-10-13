import { it, expect } from "vitest";
import { assertSandboxEvidence } from "../../scripts/ci-sandbox.mjs";
const valid = () => ({
  browser: {
    uid: 1001,
    capabilities: "0000000000000000",
    noNewPrivileges: 1,
    seccomp: 2,
    filters: 1,
    args: ["chromium"],
    namespaces: { user: "user:[1]", pid: "pid:[2]", net: "net:[3]" },
  },
  renderers: [
    {
      uid: 1001,
      capabilities: "0000000000000000",
      noNewPrivileges: 1,
      seccomp: 2,
      filters: 2,
      args: ["chromium", "--type=renderer"],
      namespaces: { user: "user:[4]", pid: "pid:[5]", net: "net:[6]" },
    },
  ],
});
it("accepts additional renderer namespace and seccomp isolation", () =>
  expect(() => assertSandboxEvidence(valid())).not.toThrow());
it.each([
  "missing",
  "no-renderer",
  "missing-namespace",
  "same-namespace",
  "same-filter",
  "root",
  "bypass",
])("rejects inconclusive or unsafe sandbox evidence: %s", (defect) => {
  const evidence = valid();
  if (defect === "missing")
    return expect(() => assertSandboxEvidence(undefined)).toThrow();
  if (defect === "no-renderer") evidence.renderers = [];
  if (defect === "missing-namespace")
    delete evidence.renderers[0].namespaces.user;
  if (defect === "same-namespace")
    evidence.renderers[0].namespaces.user = evidence.browser.namespaces.user;
  if (defect === "same-filter") evidence.renderers[0].filters = 1;
  if (defect === "root") evidence.browser.uid = 0;
  if (defect === "bypass") evidence.browser.args.push("--no-sandbox");
  expect(() => assertSandboxEvidence(evidence)).toThrow();
});

it("keeps CI browser privileges and network exposure bounded", async () => {
  const { readFile } = await import("node:fs/promises");
  const { parse } = await import("yaml");
  const compose = parse(await readFile("compose.ci.yaml", "utf8"));
  expect(compose.services.tests.user).toBe("pwuser");
  expect(compose.services.tests.cap_drop).toEqual(["ALL"]);
  expect(compose.services.tests.cap_add).toBeUndefined();
  expect(compose.services.tests.privileged).toBeUndefined();
  expect(compose.services.tests.security_opt).toContain(
    "no-new-privileges:true",
  );
  expect(compose.networks.tests.internal).toBe(true);
  for (const service of Object.values(compose.services)) {
    expect(service.ports).toBeUndefined();
    expect(service.network_mode).toBeUndefined();
  }
});

it("changes only the namespace sandbox chroot gate in the CI seccomp profile", async () => {
  const { readFile } = await import("node:fs/promises");
  const { execFileSync } = await import("node:child_process");
  const expected = JSON.parse(
    await readFile("docker/chromium-seccomp.json", "utf8"),
  );
  const chroot = expected.syscalls.find(
    (rule) => rule.names.length === 1 && rule.names[0] === "chroot",
  );
  expect(chroot.includes).toEqual({ caps: ["CAP_SYS_CHROOT"] });
  chroot.includes = {};
  const actual = JSON.parse(
    execFileSync(process.execPath, ["scripts/ci-seccomp.mjs"], {
      encoding: "utf8",
    }),
  );
  expect(actual).toEqual(expected);
});
