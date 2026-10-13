import type pg from "pg";
import { validateSource } from "../../config/sources.js";
import { transaction } from "../../shared/database.js";
import { AppError, errorCode } from "../../shared/errors.js";
import { logger } from "../../shared/logger.js";
import { fetchHtml, sourcePacer, permittedUrl } from "../network/http.js";
import { extract } from "../extraction/static.js";
import { BrowserExtractor } from "../extraction/browser.js";
import { persistPage } from "../catalog/persistence.js";
import { backoff, enqueue } from "../jobs/runs.js";
type Run = {
  id: string;
  source_id: string;
  config_snapshot: unknown;
  deadline: Date;
  attempt: number;
  status: string;
  accepted: number;
  rejected: number;
};
export async function executeRun(
  pool: pg.Pool,
  runId: string,
  browser: BrowserExtractor,
) {
  const found = await pool.query<Run>(
    "SELECT * FROM ingestion_runs WHERE id=$1",
    [runId],
  );
  const initial = found.rows[0];
  if (!initial || ["succeeded", "partial", "failed"].includes(initial.status))
    return;
  const source = validateSource(initial.config_snapshot);
  let attempt = initial.attempt;
  let activePage: string | undefined;
  try {
    const remaining = initial.deadline.getTime() - Date.now();
    if (remaining <= 0) throw new AppError("RUN_DEADLINE");
    const signal = AbortSignal.timeout(remaining);
    const started = await transaction(pool, async (client) => {
      const updated = await client.query<Run>(
        "UPDATE ingestion_runs SET status='running',started_at=coalesce(started_at,now()),attempt=attempt+1,error_code=null WHERE id=$1 RETURNING *",
        [runId],
      );
      const number = updated.rows[0]!.attempt;
      await client.query(
        "INSERT INTO ingestion_attempts(run_id,attempt) VALUES($1,$2)",
        [runId, number],
      );
      return number;
    });
    attempt = started;
    const done = await pool.query<{
      page_url: string;
      next_url: string | null;
      accepted: number;
      rejected: number;
    }>(
      "SELECT page_url,next_url,accepted,rejected FROM ingestion_page_results WHERE run_id=$1",
      [runId],
    );
    const complete = new Map(done.rows.map((r) => [r.page_url, r]));
    const pending = [...source.startUrls];
    const visited = new Set<string>();
    const pacer = sourcePacer(source);
    let items = done.rows.reduce((sum, r) => sum + r.accepted + r.rejected, 0);
    while (pending.length) {
      if (signal.aborted) throw new AppError("RUN_DEADLINE");
      const value = pending.shift()!;
      const url = permittedUrl(value, source).href;
      if (visited.has(url)) continue;
      visited.add(url);
      if (visited.size > source.limits.maxPages)
        throw new AppError("PAGE_LIMIT");
      const prior = complete.get(url);
      if (prior) {
        if (prior.next_url) pending.push(prior.next_url);
        continue;
      }
      activePage = url;
      const fetched = await fetchHtml(url, source, pacer, signal);
      let result = extract(fetched.html, source, fetched.url);
      if (
        (result.offers.length === 0 || result.rejected > 0) &&
        source.extraction.browser.enabled
      ) {
        const html = await browser.html(fetched.url, source, signal);
        result = {
          ...extract(html, source, fetched.url),
          extractor: "browser",
        };
      }
      if (!result.offers.length && result.rejected === 0)
        throw new AppError("NO_RECORDS");
      if (result.next) result.next = permittedUrl(result.next, source).href;
      items += result.offers.length + result.rejected;
      if (items > source.limits.maxItems) throw new AppError("ITEM_LIMIT");
      await persistPage(pool, runId, source.id, url, result);
      activePage = undefined;
      if (result.next) pending.push(result.next);
    }
    if (signal.aborted) throw new AppError("RUN_DEADLINE");
    await transaction(pool, async (client) => {
      await client.query(
        "UPDATE ingestion_runs SET status=CASE WHEN accepted=0 AND rejected>0 THEN 'failed' WHEN rejected>0 THEN 'partial' ELSE 'succeeded' END,finished_at=now() WHERE id=$1",
        [runId],
      );
      await client.query(
        "UPDATE ingestion_attempts SET finished_at=now() WHERE run_id=$1 AND attempt=$2",
        [runId, attempt],
      );
    });
    logger.info({ runId, sourceId: source.id, attempt }, "Ingestion completed");
  } catch (error) {
    const code = errorCode(error);
    const delay =
      error instanceof AppError
        ? Math.max(backoff(Math.max(1, attempt)), error.retryAfterMs ?? 0)
        : 0;
    const at = new Date(Date.now() + delay);
    const retry =
      error instanceof AppError &&
      error.retryable &&
      attempt < 4 &&
      at < initial.deadline;
    if (!(error instanceof AppError)) {
      logger.error(
        { runId, sourceId: source.id, code },
        "Unexpected ingestion failure",
      );
      throw error;
    }
    await transaction(pool, async (client) => {
      if (!retry && activePage)
        await client.query(
          "INSERT INTO ingestion_page_results(run_id,page_url,status,extractor,accepted,rejected,changed,error_code) VALUES($1,$2,'failed','none',0,0,0,$3) ON CONFLICT DO NOTHING",
          [runId, activePage, code],
        );
      await client.query(
        "UPDATE ingestion_runs SET status=CASE WHEN $2 THEN 'retrying' WHEN accepted>0 THEN 'partial' ELSE 'failed' END,error_code=$3,finished_at=CASE WHEN $2 THEN null ELSE now() END WHERE id=$1",
        [runId, retry, code],
      );
      await client.query(
        "UPDATE ingestion_attempts SET finished_at=now(),error_code=$3,retry_at=$4 WHERE run_id=$1 AND attempt=$2",
        [runId, attempt, code, retry ? at : null],
      );
      if (retry) await enqueue(client, source.id, runId, attempt + 1, at);
    });
    logger.warn(
      { runId, sourceId: source.id, attempt, code, retry },
      "Ingestion attempt ended",
    );
  }
}
