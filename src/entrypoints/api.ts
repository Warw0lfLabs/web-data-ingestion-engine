import { environment } from "../config/environment.js";
import { loadSources } from "../config/sources.js";
import { createPool } from "../shared/database.js";
import { buildApp } from "../modules/api/app.js";
const env = environment();
const pool = createPool(env.databaseUrl);
const app = await buildApp(
  pool,
  await loadSources(env.fixtureOrigin),
  env.apiToken,
  true,
);
app.addHook("onClose", async () => {
  await pool.end();
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    void app.close();
  });
await app.listen({ port: env.port, host: "0.0.0.0" });
