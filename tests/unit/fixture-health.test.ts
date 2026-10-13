import { it, expect } from "vitest";
import { fixtureServer, closeServer } from "../../src/entrypoints/fixtures.js";
it("keeps health probes from consuming transient fixture failures", async () => {
  const fixture = await fixtureServer(0);
  try {
    fixture.states.set("structured", { failures: 1 });
    const health = await fetch(`${fixture.origin}/health/live`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });
    expect((await fetch(`${fixture.origin}/structured`)).status).toBe(503);
    expect((await fetch(`${fixture.origin}/structured`)).status).toBe(200);
  } finally {
    await closeServer(fixture.server);
  }
});
