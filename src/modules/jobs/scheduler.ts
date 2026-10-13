import { CronExpressionParser } from "cron-parser";
import type pg from "pg";
import type { Source } from "../../config/sources.js";
import { AppError } from "../../shared/errors.js";
import { createRun } from "./runs.js";
export function latestOccurrence(cron: string, now: Date) {
  return CronExpressionParser.parse(cron, {
    tz: "UTC",
    currentDate: new Date(now.getTime() + 1),
  })
    .prev()
    .toDate();
}
export async function scheduleDue(
  pool: pg.Pool,
  sources: Source[],
  now = new Date(),
) {
  await pool.query(
    "UPDATE ingestion_runs SET status=CASE WHEN accepted>0 THEN 'partial' ELSE 'failed' END,finished_at=now(),error_code='RUN_DEADLINE' WHERE status IN ('queued','running','retrying') AND deadline<now()",
  );
  for (const source of sources) {
    if (!source.enabled) continue;
    const occurrence = latestOccurrence(source.cron, now);
    try {
      await createRun(pool, source, "scheduled", { scheduledFor: occurrence });
    } catch (error) {
      if (
        !(error instanceof AppError) ||
        !["SOURCE_BUSY", "SCHEDULE_DUPLICATE"].includes(error.code)
      )
        throw error;
    }
  }
}
