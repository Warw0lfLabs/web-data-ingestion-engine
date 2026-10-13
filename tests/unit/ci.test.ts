import { readFile, mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { parse } from "yaml";

for (const command of [
  "npm test",
  "npm run test:integration",
  "npm run test:browser",
])
  it.each([0, 23])(
    "propagates exit %i through the workflow pipeline: " + command,
    async (exitCode) => {
      const workflow = parse(
        await readFile(".github/workflows/ci.yml", "utf8"),
      );
      expect(workflow.jobs.checks.defaults.run.shell).toBe("bash");
      const body =
        command === "npm test"
          ? workflow.jobs.checks.steps.find((s: { run?: string }) =>
              s.run?.includes(command + " 2>&1 | tee"),
            )?.run
          : await readFile("scripts/ci-tests.sh", "utf8");
      expect(body).toMatch(/(?:set -o pipefail|set -euo pipefail)/);
      const pipeline = body
        .split("\n")
        .find((line: string) => line.startsWith(command + " "));
      expect(pipeline).toBeDefined();
      const step = { run: "set -o pipefail\n" + pipeline };
      const directory = await mkdtemp(join(tmpdir(), "ci-pipeline-"));
      try {
        await mkdir(join(directory, "test-logs"));
        await writeFile(
          join(directory, "npm"),
          '#!/bin/sh\nprintf "intentional pipeline probe\\n"\nexit "$PROBE_EXIT"\n',
          { mode: 0o755 },
        );
        // Execute the actual workflow body under the old implicit bash -e shell:
        // the explicit pipefail must protect it even without GitHub shell defaults.
        const result = spawnSync("/bin/bash", ["-e", "-c", step.run], {
          cwd: directory,
          env: {
            ...process.env,
            PATH: directory + ":" + process.env.PATH,
            PROBE_EXIT: String(exitCode),
          },
          encoding: "utf8",
          timeout: 5000,
        });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(exitCode);
        const log = step.run.match(/tee ([\w/-]+\.log)/)![1]!;

        expect(await readFile(join(directory, log), "utf8")).toContain(
          "intentional pipeline probe",
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
