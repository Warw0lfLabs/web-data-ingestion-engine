import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("preserves a database setup failure without a secondary fixture teardown error", () => {
  // Port zero cannot be a listening PostgreSQL destination. Exercise the actual
  // suite hooks in a separate process without connecting to any real database.
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(
        new URL("../../node_modules/vitest/vitest.mjs", import.meta.url),
      ),
      "run",
      "tests/integration/engine.test.ts",
    ],
    {
      env: {
        ...process.env,
        TEST_DATABASE_URL:
          "postgresql://ingestion:testing@127.0.0.1:0/cleanup_test",
      },
      encoding: "utf8",
      timeout: 20000,
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  const output = result.stdout + result.stderr;
  // macOS can report EADDRNOTAVAIL for destination port zero; Linux commonly
  // reports ECONNREFUSED. Both must retain the original setup error only.
  expect(output).toMatch(/ECONNREFUSED|EADDRNOTAVAIL/);
  expect(output).not.toContain("TypeError");
  expect(output).not.toContain("reading 'server'");
}, 25000);
