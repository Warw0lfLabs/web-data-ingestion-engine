import { run } from "graphile-worker";
import { Type } from "@sinclair/typebox";
import { environment } from "../config/environment.js";
import { loadSources } from "../config/sources.js";
import { validate } from "../config/validation.js";
import { createPool } from "../shared/database.js";
import { syncSources } from "../modules/jobs/runs.js";
import { scheduleDue } from "../modules/jobs/scheduler.js";
import { executeRun } from "../modules/ingestion/runner.js";
import { BrowserExtractor } from "../modules/extraction/browser.js";
import { logger } from "../shared/logger.js";
const env = environment();
const pool = createPool(env.databaseUrl);
const sources = await loadSources(env.fixtureOrigin);
const browser = new BrowserExtractor(env.browserEndpoint);
const owner = await pool.connect();
const lock = await owner.query<{ locked: boolean }>(
  "SELECT pg_try_advisory_lock(734901) AS locked",
);
if (!lock.rows[0]?.locked) throw new Error("V1 supports one worker instance");
await syncSources(pool, sources);
const payloadSchema = Type.Object(
  { runId: Type.String({ format: "uuid" }) },
  { additionalProperties: false },
);
const runner = await run({
  connectionString: env.databaseUrl,
  concurrency: 2,
  noHandleSignals: true,
  taskList: {
    ingest: async (payload) => {
      const { runId } = validate(payloadSchema, payload);
      await executeRun(pool, runId, browser);
    },
    schedule: async () => {
      await scheduleDue(pool, sources);
    },
  },
  crontab: "* * * * * schedule ?max=3",
});
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await runner.stop();
  await owner.query("SELECT pg_advisory_unlock(734901)");
  owner.release();
  await pool.end();
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    void stop();
  });
try {
  await runner.promise;
} catch {
  logger.error({ code: "WORKER_FAILURE" }, "Worker terminated");
  process.exitCode = 1;
} finally {
  await stop();
}
