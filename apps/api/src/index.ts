import { env } from "./env";
import { buildServer } from "./server";

const app = await buildServer();

/*
 * What to bind to.
 *
 * On a laptop, 127.0.0.1: the API has no business being reachable from the
 * coffee shop's wifi just because the operator opened the app.
 *
 * In a container, 0.0.0.0, because there 127.0.0.1 is the container's own
 * loopback and nothing else on the network can reach it. Caddy sitting in the
 * next container would get connection refused, which looks exactly like the
 * app being down. Compose publishes no port for this service, so the only way
 * in is still through the reverse proxy.
 */
const host = env.IS_PRODUCTION ? "0.0.0.0" : "127.0.0.1";

try {
  const address = await app.listen({ host, port: env.API_PORT });
  app.log.info(`Toreroflow API listening at ${address}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
