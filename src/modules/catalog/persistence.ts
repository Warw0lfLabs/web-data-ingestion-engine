import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { Offer } from "../normalization/model.js";
import { AppError } from "../../shared/errors.js";
import { transaction } from "../../shared/database.js";
export type PageResult = {
  offers: Offer[];
  rejected: number;
  extractor: string;
  next?: string;
};
export async function persistPage(
  pool: pg.Pool,
  runId: string,
  sourceId: string,
  pageUrl: string,
  result: PageResult,
): Promise<void> {
  await transaction(pool, async (client) => {
    const locked = await client.query<{ status: string; deadline: Date }>(
      "SELECT status,deadline FROM ingestion_runs WHERE id=$1 FOR UPDATE",
      [runId],
    );
    if (
      locked.rows[0]?.status !== "running" ||
      locked.rows[0].deadline.getTime() <= Date.now()
    )
      throw new AppError("RUN_DEADLINE");
    const deadline = locked.rows[0].deadline.getTime();
    async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
      sql: string,
      values?: unknown[],
    ): Promise<pg.QueryResult<T>> {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new AppError("RUN_DEADLINE");
      await client.query("SELECT set_config('statement_timeout',$1,true)", [
        `${Math.min(15000, remaining)}ms`,
      ]);
      try {
        return await client.query<T>(sql, values);
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "57014"
        )
          throw new AppError(
            Date.now() >= deadline ? "RUN_DEADLINE" : "PERSISTENCE_TIMEOUT",
            Date.now() < deadline,
          );
        throw error;
      }
    }
    const previous = await query(
      "SELECT 1 FROM ingestion_page_results WHERE run_id=$1 AND page_url=$2",
      [runId, pageUrl],
    );
    if (previous.rowCount) return;
    let changed = 0;
    for (const offer of result.offers) {
      const product = await query<{ id: string }>(
        "INSERT INTO products(id,source_id,external_key,canonical_url,title) VALUES($1,$2,$3,$4,$5) ON CONFLICT(source_id,external_key) DO UPDATE SET title=EXCLUDED.title,canonical_url=EXCLUDED.canonical_url,last_seen_at=now() RETURNING id",
        [randomUUID(), sourceId, offer.externalKey, offer.url, offer.title],
      );
      const variant = await query<{ id: string }>(
        "INSERT INTO variants(id,product_id,external_key,attributes) VALUES($1,$2,$3,$4) ON CONFLICT(product_id,external_key) DO UPDATE SET attributes=EXCLUDED.attributes,last_seen_at=now() RETURNING id",
        [randomUUID(), product.rows[0]!.id, offer.variantKey, offer.attributes],
      );
      const variantId = variant.rows[0]!.id;
      const current = await query<{
        price: string;
        currency: string;
        availability: string;
      }>(
        "SELECT price,currency,availability FROM offer_current WHERE variant_id=$1 FOR UPDATE",
        [variantId],
      );
      const old = current.rows[0];
      const differs =
        !old ||
        old.price !== offer.price ||
        old.currency !== offer.currency ||
        old.availability !== offer.availability;
      if (differs) {
        changed++;
        await query(
          "INSERT INTO offer_history(variant_id,price,currency,availability,run_id) VALUES($1,$2,$3,$4,$5)",
          [variantId, offer.price, offer.currency, offer.availability, runId],
        );
      }
      await query(
        "INSERT INTO offer_current(variant_id,price,currency,availability,last_observed_at,last_changed_at,run_id) VALUES($1,$2,$3,$4,now(),now(),$5) ON CONFLICT(variant_id) DO UPDATE SET price=EXCLUDED.price,currency=EXCLUDED.currency,availability=EXCLUDED.availability,last_observed_at=now(),last_changed_at=CASE WHEN $6 THEN now() ELSE offer_current.last_changed_at END,run_id=$5",
        [
          variantId,
          offer.price,
          offer.currency,
          offer.availability,
          runId,
          differs,
        ],
      );
    }
    await query(
      "INSERT INTO ingestion_page_results(run_id,page_url,next_url,status,extractor,accepted,rejected,changed,error_code) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [
        runId,
        pageUrl,
        result.next ?? null,
        result.rejected ? "partial" : "succeeded",
        result.extractor,
        result.offers.length,
        result.rejected,
        changed,
        result.rejected ? "INVALID_RECORD" : null,
      ],
    );
    await query(
      "UPDATE ingestion_runs SET accepted=accepted+$2,rejected=rejected+$3,changed=changed+$4 WHERE id=$1",
      [runId, result.offers.length, result.rejected, changed],
    );
    if (Date.now() >= deadline) throw new AppError("RUN_DEADLINE");
  });
}
