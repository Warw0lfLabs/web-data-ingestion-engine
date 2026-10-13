import { runner } from "node-pg-migrate";
import { makeWorkerUtils } from "graphile-worker";
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL required");
await runner({
  databaseUrl,
  dir: "migrations",
  direction: "up",
  migrationsTable: "app_migrations",
  checkOrder: true,
});
const utils = await makeWorkerUtils({ connectionString: databaseUrl });
try {
  await utils.migrate();
} finally {
  await utils.release();
}

// Compose bootstraps a separate non-owner role; only this migration process grants access.
const runtimeRole = process.env.RUNTIME_DATABASE_ROLE;
if (runtimeRole) {
  const { createPool } = await import("../shared/database.js");
  const { grantRuntimeDatabase } =
    await import("../shared/runtime-database.js");
  const pool = createPool(databaseUrl);
  try {
    await grantRuntimeDatabase(pool, runtimeRole);
  } finally {
    await pool.end();
  }
}
