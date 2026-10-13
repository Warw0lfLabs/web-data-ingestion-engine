import { it, expect } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  symlink,
  rm,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";

const root = resolve(".");
const dockerMock = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const scenario = process.env.SCENARIO;
fs.appendFileSync(process.env.COMMAND_LOG, JSON.stringify({args,cwd:process.cwd()})+'\\n');
const has = v => args.includes(v);
const fail = () => { console.error('sensitive-sentinel'); process.exit(17); };
if (args[0] === 'info') { if(scenario === 'daemon') fail(); process.exit(0); }
if (args[0] === 'inspect') {
  if(scenario === 'inspect') fail();
  if(scenario === 'invalid-json') { console.log('{'); process.exit(0); }
  const service = process.env.SERVICE_NAMES.split(',')[Number.parseInt(args.at(-1),16)-1];
  let state = service === 'migrate' ? {Status:'exited',Running:false,ExitCode:0} : {Status:'running',Running:true,ExitCode:0,Health:{Status:'healthy'}};
  if(service === 'migrate' && scenario === 'migration-1') state.ExitCode = 1;
  if(service === 'migrate' && scenario === 'migration-running') state = {Status:'running',Running:true,ExitCode:0};
  if(service === 'api') {
    if(scenario === 'unhealthy') state.Health.Status = 'unhealthy';
    if(scenario === 'no-health') delete state.Health;
    if(scenario === 'stopped') state = {Status:'exited',Running:false,ExitCode:0};
    if(scenario === 'unexpected') state.Status = 'restarting';
    if(scenario === 'state-secret') state.Status = 'sensitive-sentinel'.repeat(10);
  }
  console.log(JSON.stringify(state)); process.exit(0);
}
if(has('version')) { if(scenario === 'compose') fail(); process.exit(0); }
if(has('config')) {
  if(scenario === 'config') fail();
  if(has('--format')) console.log(fs.readFileSync(process.env.CONFIG_JSON,'utf8'));
  process.exit(0);
}
if(has('stop')) { if(scenario === 'stop') fail(); process.exit(0); }
if(has('up')) { if(scenario === 'up') fail(); process.exit(0); }
if(has('ps')) {
  if(scenario === 'ps') fail();
  const service = args.at(-1);
  if((scenario === 'missing-migrate' && service === 'migrate') || (scenario === 'missing-api' && service === 'api')) process.exit(0);
  const id = (process.env.SERVICE_NAMES.split(',').indexOf(service)+1).toString(16).padStart(64,'0');
  console.log(id);
  if(scenario === 'multiple') console.log(id);
  process.exit(0);
}
fail();
`;

async function invoke(
  scenario: string,
  selection: Record<string, string> = {},
  changeConfig?: (config: ReturnType<typeof parse>) => void,
) {
  const directory = await mkdtemp(join(tmpdir(), "stack workflow "));
  try {
    const project = join(directory, "project with spaces");
    const bin = join(directory, "bin");
    await mkdir(join(project, "scripts"), { recursive: true });
    await mkdir(bin);
    await writeFile(
      join(project, "compose.yaml"),
      await readFile(join(root, "compose.yaml")),
    );
    await writeFile(join(project, "alternate.yaml"), "services: {}\n");
    if (scenario === "dotenv-target")
      await writeFile(join(project, ".env"), "COMPOSE_PROJECT_NAME=other\n");
    const cleanEnvironment = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !key.startsWith("COMPOSE_") &&
          key !== "INGESTION_STACK_ALLOW_ALTERNATE_TARGET",
      ),
    );
    const selectedEnvironment = Object.fromEntries(
      Object.entries(selection).map(([key, value]) => [
        key,
        value.replaceAll("$PROJECT", project),
      ]),
    );
    await writeFile(
      join(project, "scripts/stack-restart.sh"),
      await readFile(join(root, "scripts/stack-restart.sh")),
    );
    if (scenario !== "node") await symlink(process.execPath, join(bin, "node"));
    await symlink("/usr/bin/dirname", join(bin, "dirname"));
    if (scenario !== "docker")
      await writeFile(join(bin, "docker"), dockerMock, { mode: 0o755 });
    const config = parse(await readFile(join(root, "compose.yaml"), "utf8"));
    if (scenario === "extra-service")
      config.services.extra = { healthcheck: { test: ["CMD", "true"] } };
    if (scenario === "unsupported") delete config.services.api.healthcheck;
    changeConfig?.(config);
    config.name =
      selectedEnvironment.COMPOSE_PROJECT_NAME ?? "web-data-ingestion-engine";
    if (scenario === "identity-mismatch") config.name = "unexpected-project";
    const configPath = join(directory, "config.json");
    const log = join(directory, "commands.jsonl");
    await writeFile(configPath, JSON.stringify(config));
    await writeFile(log, "");
    const result = spawnSync(
      "/bin/bash",
      [join(project, "scripts/stack-restart.sh")],
      {
        cwd: directory,
        env: {
          ...cleanEnvironment,
          ...selectedEnvironment,
          PATH: bin,
          SCENARIO: scenario,
          CONFIG_JSON: configPath,
          COMMAND_LOG: log,
          SERVICE_NAMES: Object.keys(config.services).join(","),
        },
        encoding: "utf8",
        timeout: 10000,
      },
    );
    const calls: { args: string[]; cwd: string }[] = (
      await readFile(log, "utf8")
    )
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    return { ...result, calls, project: await realpath(project) };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const lifecycleGates = [
  ["migrate", "postgres"],
  ["api", "migrate"],
  ["worker", "migrate"],
  ["worker", "fixture-server"],
  ["worker", "browser"],
] as const;

it("accepts resolved mandatory dependencies for an acknowledged alternate file", async () => {
  const result = await invoke(
    "success",
    {
      COMPOSE_FILE: "$PROJECT/alternate.yaml",
      INGESTION_STACK_ALLOW_ALTERNATE_TARGET: "1",
    },
    (config) => {
      for (const [service, dependency] of lifecycleGates)
        config.services[service].depends_on[dependency].required = true;
    },
  );
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("Stack verified");
});

it.each(
  lifecycleGates.flatMap(([service, dependency]) =>
    [
      "missing",
      "started",
      "wrong-condition",
      "optional",
      "invalid-required",
      "null",
      "short",
      "missing-map",
      "missing-service",
    ].map((defect) => ({ service, dependency, defect })),
  ),
)(
  "rejects $service -> $dependency: $defect before mutation",
  async ({ service, dependency, defect }) => {
    const result = await invoke(
      "success",
      {
        COMPOSE_FILE: "$PROJECT/alternate.yaml",
        INGESTION_STACK_ALLOW_ALTERNATE_TARGET: "1",
      },
      (config) => {
        const dependencies = config.services[service].depends_on;
        switch (defect) {
          case "missing":
            delete dependencies[dependency];
            break;
          case "started":
            dependencies[dependency].condition = "service_started";
            break;
          case "wrong-condition":
            dependencies[dependency].condition = "invalid";
            break;
          case "optional":
            dependencies[dependency].required = false;
            break;
          case "invalid-required":
            dependencies[dependency].required = "true";
            break;
          case "null":
            dependencies[dependency] = null;
            break;
          case "short":
            config.services[service].depends_on = [dependency];
            break;
          case "missing-map":
            delete config.services[service].depends_on;
            break;
          case "missing-service":
            delete config.services[dependency];
            break;
        }
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Unsupported Compose service configuration",
    );
    expect(result.stdout).not.toContain("Stopping stack");
    expect(
      result.calls.some(
        ({ args }) => args.includes("stop") || args.includes("up"),
      ),
    ).toBe(false);
  },
);

it.each(["success", "extra-service"])(
  "verifies ordered restart and every configured container: %s",
  async (scenario) => {
    const result = await invoke(scenario);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("migrate exited 0");
    expect(result.stdout).toContain("running and healthy");
    const commands = result.calls.map((c) => c.args);
    const stop = commands.findIndex((c) => c.includes("stop"));
    const up = commands.findIndex((c) => c.includes("up"));
    expect(stop).toBeGreaterThan(
      commands.findIndex((c) => c.includes("config")),
    );
    expect(up).toBeGreaterThan(stop);
    expect(commands[up]!.slice(-3)).toEqual(["up", "-d", "--wait"]);
    expect(result.stdout).toContain(
      "Effective Compose project: web-data-ingestion-engine",
    );
    expect(result.stdout.indexOf("Compose files:")).toBeLessThan(
      result.stdout.indexOf("Stopping stack"),
    );
    expect(commands.filter((c) => c[0] === "inspect")).toHaveLength(
      scenario === "extra-service" ? 7 : 6,
    );
    expect(result.calls.every((c) => c.cwd === result.project)).toBe(true);
  },
);

it.each([
  ["docker", "Docker is unavailable"],
  ["compose", "Docker Compose is unavailable"],
  ["node", "Node.js is unavailable"],
  ["daemon", "Docker daemon is unavailable"],
  ["config", "Invalid Compose configuration"],
  ["unsupported", "Unsupported Compose service configuration"],
  ["stop", "Compose stop failed"],
  ["up", "Compose up failed"],
  ["migration-1", "Service migrate: state=exited, exit=1"],
  ["migration-running", "Service migrate: state=running"],
  ["missing-migrate", "Missing required service migrate"],
  ["unhealthy", "health=unhealthy"],
  ["missing-api", "Missing required service api"],
  ["stopped", "Service api: state=exited"],
  ["unexpected", "Service api: state=restarting"],
  ["no-health", "health=missing"],
  ["multiple", "Expected exactly one container"],
  ["inspect", "Could not inspect service"],
  ["ps", "Could not locate container"],
  ["invalid-json", "invalid inspection response"],
])("fails visibly and safely: %s", async (scenario, diagnostic) => {
  const result = await invoke(scenario);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(diagnostic);
  expect(result.stdout).not.toContain("Stack verified");
  expect(result.stdout + result.stderr).not.toContain("sensitive-sentinel");
  if (
    ["docker", "node", "compose", "daemon", "config", "unsupported"].includes(
      scenario,
    )
  )
    expect(result.calls.some((c) => c.args.includes("stop"))).toBe(false);
  if (scenario === "stop")
    expect(result.calls.some((c) => c.args.includes("up"))).toBe(false);
});

it("never invokes destructive volume operations or native restart", async () => {
  const result = await invoke("success");
  for (const call of result.calls)
    expect(
      call.args.some((v) =>
        [
          "restart",
          "down",
          "rm",
          "volume",
          "--volumes",
          "-v",
          "--force-recreate",
        ].includes(v),
      ),
    ).toBe(false);
  const script = await readFile("scripts/stack-restart.sh", "utf8");
  expect(script).not.toMatch(/\bsleep\b/);
});

it.each([
  [
    { COMPOSE_PROJECT_NAME: "isolated-test" },
    false,
    "Alternate target requires",
  ],
  [
    {
      COMPOSE_PROJECT_NAME: "isolated-test",
      INGESTION_STACK_ALLOW_ALTERNATE_TARGET: "1",
    },
    true,
    "Effective Compose project: isolated-test",
  ],
  [
    { COMPOSE_FILE: "$PROJECT/alternate.yaml" },
    false,
    "Alternate target requires",
  ],
  [
    {
      COMPOSE_FILE: "$PROJECT/compose.yaml:$PROJECT/alternate.yaml",
      INGESTION_STACK_ALLOW_ALTERNATE_TARGET: "1",
    },
    true,
    "Compose files:",
  ],
  [
    {
      COMPOSE_PROJECT_NAME: "web-data-ingestion-engine",
      COMPOSE_FILE: "$PROJECT/compose.yaml",
    },
    true,
    "Stack verified",
  ],
  [{ COMPOSE_PROJECT_NAME: "" }, false, "Invalid or ambiguous"],
  [
    {
      COMPOSE_PROJECT_NAME: "bad/name",
      INGESTION_STACK_ALLOW_ALTERNATE_TARGET: "1",
    },
    false,
    "Invalid or ambiguous",
  ],
  [
    {
      COMPOSE_FILE: "relative.yaml",
      INGESTION_STACK_ALLOW_ALTERNATE_TARGET: "1",
    },
    false,
    "Invalid or ambiguous",
  ],
  [
    {
      COMPOSE_FILE: "$PROJECT/missing.yaml",
      INGESTION_STACK_ALLOW_ALTERNATE_TARGET: "1",
    },
    false,
    "Invalid or ambiguous",
  ],
  [
    {
      COMPOSE_FILE: "$PROJECT/compose.yaml:$PROJECT/compose.yaml",
      INGESTION_STACK_ALLOW_ALTERNATE_TARGET: "1",
    },
    false,
    "Invalid or ambiguous",
  ],
  [{ COMPOSE_PATH_SEPARATOR: ";" }, false, "Invalid or ambiguous"],
  [{ COMPOSE_ENV_FILES: "/secret.env" }, false, "Invalid or ambiguous"],
  [{ COMPOSE_PROFILES: "extra" }, false, "Invalid or ambiguous"],
  [
    {
      COMPOSE_PROJECT_NAME: "isolated-test",
      INGESTION_STACK_ALLOW_ALTERNATE_TARGET: "yes",
    },
    false,
    "Alternate target requires",
  ],
] as const)(
  "guards target selection %j",
  async (selection, allowed, diagnostic) => {
    const result = await invoke("success", { ...selection });
    expect(result.status).toBe(allowed ? 0 : 1);
    expect(result.stdout + result.stderr).toContain(diagnostic);
    expect(result.calls.some((c) => c.args.includes("stop"))).toBe(allowed);
    if (allowed) {
      const stop = result.calls.find((c) => c.args.includes("stop"))!;
      expect(stop.args).toContain("-p");
      expect(stop.args).toContain("-f");
    }
  },
);

it("rejects implicit Compose target settings from .env before mutation", async () => {
  const result = await invoke("dotenv-target");
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Invalid or ambiguous");
  expect(result.calls.some((c) => c.args.includes("stop"))).toBe(false);
});

it("sanitizes inherited Compose controls and alternate-target acknowledgment", async () => {
  const values = {
    COMPOSE_PROJECT_NAME: "unrelated",
    COMPOSE_FILE: "/missing.yaml",
    COMPOSE_PROFILES: "unsafe",
    INGESTION_STACK_ALLOW_ALTERNATE_TARGET: "1",
  };
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  try {
    Object.assign(process.env, values);
    const result = await invoke("success");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "Effective Compose project: web-data-ingestion-engine",
    );
    expect(result.stdout).not.toContain("unrelated");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

it("rejects a resolved project identity mismatch before stop", async () => {
  const result = await invoke("identity-mismatch");
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Unsupported Compose service configuration");
  expect(result.calls.some((c) => c.args.includes("stop"))).toBe(false);
});
