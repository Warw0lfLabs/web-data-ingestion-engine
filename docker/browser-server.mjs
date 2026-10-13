import { chromium } from "playwright";
const server = await chromium.launchServer({
  host: "0.0.0.0",
  port: 3001,
  wsPath: "/",
  chromiumSandbox: true,
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    void server.close();
  });
