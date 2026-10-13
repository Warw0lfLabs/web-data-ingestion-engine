-- Disposable Compose credentials; replace before any non-local deployment.
CREATE ROLE ingestion_runtime LOGIN PASSWORD 'development-runtime'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
