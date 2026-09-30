import type { Server } from "node:http";
import type { Express } from "express";

export type ListenConfig = { port: number; host: string };

/**
 * Where the container listens. Helm7 sets PORT=3000 and routes to it from
 * outside the container, so the bind address has to be reachable from there:
 * loopback would pass every local check and fail every health probe.
 *
 * The bind address is read from LISTEN_HOST, never HOSTNAME. Container runtimes
 * set HOSTNAME to the container id, which resolves to nothing useful here, and
 * this is not a framework that treats it as a bind address.
 *
 * A malformed PORT throws instead of falling back to a default: a service that
 * quietly listens somewhere the platform is not looking looks healthy in its
 * own logs and unreachable everywhere else.
 */
export function resolveListenConfig(
  env: Record<string, string | undefined>,
): ListenConfig {
  const rawPort = env.PORT?.trim();
  let port = 3000;
  if (rawPort) {
    port = Number(rawPort);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error(
        `PORT must be an integer from 0 to 65535, got "${rawPort}".`,
      );
    }
  }
  return { port, host: env.LISTEN_HOST?.trim() || "0.0.0.0" };
}

/**
 * Starts the app and wires shutdown. Split from start.ts so it can be tested on
 * an ephemeral port.
 */
export function serve(
  app: Express,
  env: Record<string, string | undefined> = process.env,
): Promise<Server> {
  const { port, host } = resolveListenConfig(env);
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => resolve(server));
    server.once("error", reject);

    // Node's 5 second default is shorter than a reverse proxy's idle timeout,
    // so the proxy reuses a connection Node has just closed and the caller sees
    // an intermittent 502. headersTimeout must stay above keepAliveTimeout or
    // Node cuts the connection first anyway.
    server.keepAliveTimeout = 65_000;
    server.headersTimeout = 66_000;
  });
}

/**
 * As PID 1 in a container Node ignores SIGTERM unless it handles it, so a
 * deploy would wait out the platform's kill timeout and then SIGKILL requests
 * that were still being answered.
 */
export function shutdownOnSignals(server: Server, graceMs = 10_000): void {
  const stop = () => {
    // Long enough for an in-flight tool call to finish, short enough to stay
    // inside the platform's own stop timeout.
    setTimeout(() => process.exit(1), graceMs).unref();
    server.close(() => process.exit(0));
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
