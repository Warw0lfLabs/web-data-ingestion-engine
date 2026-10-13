import { randomUUID } from "node:crypto";
import type pg from "pg";
import { sourceHash, type Source } from "../../config/sources.js";
import { transaction } from "../../shared/database.js";
import { AppError } from "../../shared/errors.js";
export async function syncSources(pool: pg.Pool, sources: Source[]) {
  await transaction(pool, async (client) => {
    await client.query("UPDATE sources SET enabled=false");
    for (const source of sources)
      await client.query(
        "INSERT INTO sources(id,name,enabled) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET name=$2,enabled=$3",
        [source.id, source.name, source.enabled],
      );
  });
}
export async function enqueue(
  client: pg.PoolClient,
  sourceId: string,
  runId: string,
  attempt: number,
  at = new Date(),
) {
  await client.query(
    "SELECT graphile_worker.add_job('ingest',payload := $1::json,queue_name := $2,run_at := $3,max_attempts := 3,job_key := $4,job_key_mode := 'unsafe_dedupe')",
    [JSON.stringify({ runId }), sourceId, at, `${runId}:${attempt}`],
  );
}
export async function createRun(
  pool: pg.Pool,
  source: Source,
  trigger: "manual" | "scheduled",
  options: { idempotencyKey?: string; scheduledFor?: Date } = {},
) {
  return transaction(pool, async (client) => {
    await client.query("SELECT id FROM sources WHERE id=$1 FOR UPDATE", [
      source.id,
    ]);
    if (options.idempotencyKey) {
      const previous = await client.query<{ id: string }>(
        "SELECT id FROM ingestion_runs WHERE source_id=$1 AND idempotency_key=$2",
        [source.id, options.idempotencyKey],
      );
      if (previous.rows[0]) return { id: previous.rows[0].id, reused: true };
    }
    if (options.scheduledFor) {
      const previous = await client.query(
        "SELECT id FROM ingestion_runs WHERE source_id=$1 AND scheduled_for=$2",
        [source.id, options.scheduledFor],
      );
      if (previous.rowCount) throw new AppError("SCHEDULE_DUPLICATE");
    }
    const active = await client.query<{ id: string }>(
      "SELECT id FROM ingestion_runs WHERE source_id=$1 AND status IN ('queued','running','retrying')",
      [source.id],
    );
    if (active.rowCount) throw new AppError("SOURCE_BUSY");
    const id = randomUUID();
    await client.query(
      "INSERT INTO ingestion_runs(id,source_id,config_hash,config_snapshot,trigger,scheduled_for,idempotency_key,deadline) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        id,
        source.id,
        sourceHash(source),
        source,
        trigger,
        options.scheduledFor ?? null,
        options.idempotencyKey ?? null,
        new Date(Date.now() + source.limits.runTimeoutMs),
      ],
    );
    await enqueue(client, source.id, id, 1);
    return { id, reused: false };
  });
}
export function backoff(attempt: number, random = Math.random): number {
  return Math.floor(
    Math.min(60000, 5000 * 2 ** (attempt - 1)) * (0.5 + random() * 0.5),
  );
}
