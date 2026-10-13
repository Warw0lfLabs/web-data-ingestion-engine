import type pg from "pg";

/** Grants operational DML without ownership, schema creation, or global RLS bypass. */
export async function grantRuntimeDatabase(pool: pg.Pool, runtimeRole: string) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(runtimeRole))
    throw new Error("Invalid runtime database role");
  await pool.query(
    `GRANT USAGE ON SCHEMA public, graphile_worker TO "${runtimeRole}"`,
  );
  await pool.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public, graphile_worker TO "${runtimeRole}"`,
  );
  await pool.query(
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public, graphile_worker TO "${runtimeRole}"`,
  );
  await pool.query(
    `REVOKE INSERT, UPDATE, DELETE ON public.app_migrations, graphile_worker.migrations FROM "${runtimeRole}"`,
  );
  await pool.query(
    `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA graphile_worker TO "${runtimeRole}"`,
  );
  // Graphile enables RLS without policies on its private tables. Explicitly
  // authorize only this trusted service role instead of granting BYPASSRLS.
  const tables = await pool.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname='graphile_worker' AND rowsecurity",
  );
  for (const { tablename } of tables.rows) {
    const table = '"' + tablename.replaceAll('"', '""') + '"';
    await pool.query(
      `DROP POLICY IF EXISTS runtime_service ON graphile_worker.${table}`,
    );
    await pool.query(
      `CREATE POLICY runtime_service ON graphile_worker.${table} TO "${runtimeRole}" USING (true) WITH CHECK (true)`,
    );
  }
}
