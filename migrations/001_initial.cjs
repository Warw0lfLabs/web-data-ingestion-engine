exports.up = (pgm) =>
  pgm.sql(`
CREATE TABLE sources (id text PRIMARY KEY, name text NOT NULL, enabled boolean NOT NULL);
CREATE TABLE ingestion_runs (
 id uuid PRIMARY KEY, source_id text NOT NULL REFERENCES sources(id), config_hash text NOT NULL, config_snapshot jsonb NOT NULL,
 trigger text NOT NULL CHECK(trigger IN ('manual','scheduled')), scheduled_for timestamptz, idempotency_key text,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','retrying','succeeded','partial','failed')),
 created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz, deadline timestamptz NOT NULL,
 attempt integer NOT NULL DEFAULT 0, accepted integer NOT NULL DEFAULT 0, rejected integer NOT NULL DEFAULT 0,
 changed integer NOT NULL DEFAULT 0, error_code text, UNIQUE(source_id,scheduled_for), UNIQUE(source_id,idempotency_key));
CREATE UNIQUE INDEX one_active_source ON ingestion_runs(source_id) WHERE status IN ('queued','running','retrying');
CREATE INDEX runs_created ON ingestion_runs(created_at DESC,id);
CREATE TABLE ingestion_attempts (run_id uuid NOT NULL REFERENCES ingestion_runs(id), attempt integer NOT NULL, started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz, error_code text, retry_at timestamptz, PRIMARY KEY(run_id,attempt));
CREATE TABLE ingestion_page_results (run_id uuid NOT NULL REFERENCES ingestion_runs(id), page_url text NOT NULL, next_url text, status text NOT NULL CHECK(status IN ('succeeded','partial','failed')), extractor text NOT NULL, accepted integer NOT NULL, rejected integer NOT NULL, changed integer NOT NULL, error_code text, PRIMARY KEY(run_id,page_url));
CREATE TABLE products (id uuid PRIMARY KEY, source_id text NOT NULL REFERENCES sources(id), external_key text NOT NULL, canonical_url text NOT NULL, title text NOT NULL, first_seen_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(), UNIQUE(source_id,external_key));
CREATE INDEX products_source ON products(source_id,id);
CREATE TABLE variants (id uuid PRIMARY KEY, product_id uuid NOT NULL REFERENCES products(id), external_key text NOT NULL, attributes jsonb NOT NULL DEFAULT '{}', first_seen_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(), UNIQUE(product_id,external_key));
CREATE TABLE offer_current (variant_id uuid PRIMARY KEY REFERENCES variants(id), price numeric(20,6) NOT NULL CHECK(price>=0), currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'), availability text NOT NULL CHECK(availability IN ('in_stock','out_of_stock','preorder','unknown')), last_observed_at timestamptz NOT NULL, last_changed_at timestamptz NOT NULL, run_id uuid NOT NULL REFERENCES ingestion_runs(id));
CREATE TABLE offer_history (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, variant_id uuid NOT NULL REFERENCES variants(id), price numeric(20,6) NOT NULL CHECK(price>=0), currency text NOT NULL, availability text NOT NULL CHECK(availability IN ('in_stock','out_of_stock','preorder','unknown')), observed_at timestamptz NOT NULL DEFAULT now(), run_id uuid NOT NULL REFERENCES ingestion_runs(id));
CREATE INDEX history_variant ON offer_history(variant_id,id);
`);
exports.down = (pgm) =>
  pgm.sql(
    "DROP TABLE offer_history, offer_current, variants, products, ingestion_page_results, ingestion_attempts, ingestion_runs, sources",
  );
