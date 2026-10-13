FROM postgres:17-bookworm
COPY docker/init-runtime.sql /docker-entrypoint-initdb.d/init-runtime.sql
