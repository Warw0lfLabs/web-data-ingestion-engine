import pg from "pg";
const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 2000,
  statement_timeout: 2000,
});
try {
  await client.connect();
  const result = await client.query(
    "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=0 AND objid=734901 AND granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())) AS ready",
  );
  if (!result.rows[0]?.ready) process.exitCode = 1;
} catch {
  process.exitCode = 1;
} finally {
  await client.end();
}
