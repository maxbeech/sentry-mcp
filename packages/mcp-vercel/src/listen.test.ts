import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import app from "./index.js";
import { resolveListenConfig, serve } from "./listen.js";

describe("resolveListenConfig", () => {
  it("defaults to 0.0.0.0:3000, the address Helm7 routes to", () => {
    expect(resolveListenConfig({})).toEqual({ port: 3000, host: "0.0.0.0" });
  });

  it("follows PORT", () => {
    expect(resolveListenConfig({ PORT: "4123" }).port).toBe(4123);
  });

  it("ignores HOSTNAME, which container runtimes set to the container id", () => {
    expect(resolveListenConfig({ HOSTNAME: "3f9c2a1b7d4e" }).host).toBe(
      "0.0.0.0",
    );
  });

  it("lets LISTEN_HOST narrow the bind address", () => {
    expect(resolveListenConfig({ LISTEN_HOST: "127.0.0.1" }).host).toBe(
      "127.0.0.1",
    );
  });

  it.each(["abc", "3000.5", "-1", "70000"])(
    "refuses PORT=%s rather than listening somewhere else",
    (PORT) => {
      expect(() => resolveListenConfig({ PORT })).toThrow(/PORT/);
    },
  );
});

describe("serve", () => {
  let server: Server | undefined;
  afterEach(
    () =>
      new Promise<void>((resolve) => {
        if (!server) return resolve();
        server.close(() => resolve());
        server = undefined;
      }),
  );

  it("answers GET / on the configured port", async () => {
    server = await serve(app, { PORT: "0", LISTEN_HOST: "127.0.0.1" });
    const { port } = server.address() as AddressInfo;

    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ endpoints: { mcp: "/mcp" } });
  });

  it("keeps connections open longer than a reverse proxy will", async () => {
    server = await serve(app, { PORT: "0", LISTEN_HOST: "127.0.0.1" });
    expect(server.keepAliveTimeout).toBeGreaterThan(60_000);
    expect(server.headersTimeout).toBeGreaterThan(server.keepAliveTimeout);
  });

  it("rejects when the port is taken instead of hanging", async () => {
    server = await serve(app, { PORT: "0", LISTEN_HOST: "127.0.0.1" });
    const { port } = server.address() as AddressInfo;

    await expect(
      serve(app, { PORT: String(port), LISTEN_HOST: "127.0.0.1" }),
    ).rejects.toThrow(/EADDRINUSE/);
  });
});
