import { readFile } from "node:fs/promises";
import { it, expect } from "vitest";
import { parse } from "yaml";
it("connects worker and browser on a dedicated control network and keeps data isolated", async () => {
  const compose = parse(await readFile("compose.yaml", "utf8"));
  const services = compose.services;
  expect(services.worker.networks).toContain("browser-control");
  expect(services.browser.networks).toContain("browser-control");
  expect(services.browser.networks).not.toContain("data");
  expect(services.browser.networks).not.toContain("api-ingress");
  expect(services.postgres.networks).toEqual(["data"]);
  expect(services.api.networks).toContain("api-ingress");
  expect(compose.networks["api-ingress"].internal).not.toBe(true);
  for (const name of ["postgres", "api", "worker", "fixture-server", "browser"])
    expect(services[name].healthcheck.test).toBeDefined();
});

it("removes Docker-host bridge gateways from all internal networks", async () => {
  const compose = parse(await readFile("compose.yaml", "utf8"));
  for (const name of [
    "browser-control",
    "browser-fixtures",
    "extraction",
    "data",
  ])
    expect(
      compose.networks[name].driver_opts[
        "com.docker.network.bridge.gateway_mode_ipv4"
      ],
    ).toBe("isolated");
});

it("uses a non-superuser role for API and worker, with owner credentials reserved for migrations", async () => {
  const compose = parse(await readFile("compose.yaml", "utf8"));
  for (const name of ["api", "worker"])
    expect(
      new URL(compose.services[name].environment.DATABASE_URL).username,
    ).toBe("ingestion_runtime");
  expect(
    new URL(compose.services.migrate.environment.DATABASE_URL).username,
  ).toBe("ingestion");
  expect(await readFile("docker/init-runtime.sql", "utf8")).toContain(
    "NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION",
  );
});
