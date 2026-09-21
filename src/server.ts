import Fastify from "fastify";
import App from "./app.js";
import { loadOptions } from "./options.js";

const options = loadOptions();
const app = Fastify(options);
await app.register(App, options);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    app.close().catch((error: unknown) => {
      app.log.error(error);
      process.exitCode = 1;
    });
  });
}
try {
  await app.listen({
    host: process.env.HOST ?? "127.0.0.1",
    port: Number(process.env.PORT ?? 3000),
  });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exitCode = 1;
}
