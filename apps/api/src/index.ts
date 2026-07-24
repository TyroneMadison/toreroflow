import { env } from "./env";
import { buildServer } from "./server";

const app = await buildServer();

try {
  const address = await app.listen({ host: "127.0.0.1", port: env.API_PORT });
  app.log.info(`Toreroflow API listening at ${address}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
