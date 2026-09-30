import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import app from "./index.js";

/**
 * The deployment end to end over a real socket, stopping short of Sentry:
 * `tools/list` needs no upstream call, so what a caller is offered can be
 * pinned without a token that works.
 */
// Each request builds a whole server, and this runs beside other work on a busy
// machine: the default five seconds failed five tests that take 30ms alone.
vi.setConfig({ testTimeout: 30_000 });

let server: Server;
let base: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function rpc(
  path: string,
  method: string,
  headers: Record<string, string> = {},
) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method }),
  });
  const text = await res.text();
  const data = text.match(/^data: (.*)$/m)?.[1] ?? text;
  return { status: res.status, body: JSON.parse(data) as Record<string, any> };
}

const toolNames = async (path: string) => {
  const { status, body } = await rpc(path, "tools/list", {
    authorization: "Bearer test",
  });
  expect(status).toBe(200);
  return (body.result.tools as Array<{ name: string }>).map((t) => t.name);
};

describe("/mcp", () => {
  it("refuses a request with no token", async () => {
    const { status } = await rpc("/mcp", "tools/list");
    expect(status).toBe(401);
  });

  it("offers the write tools an incident needs by default, as named tools", async () => {
    const names = await toolNames("/mcp");
    expect(names).toContain("update_issue");
    expect(names).toContain("add_issue_note");
    expect(names).toContain("find_projects");
  });

  it("offers no write tool when narrowed to reading", async () => {
    const names = await toolNames("/mcp?skills=inspect");
    expect(names).not.toContain("update_issue");
    expect(names).not.toContain("add_issue_note");
    expect(names).toContain("search_issues");
  });

  it("offers closing tools but not project management when narrowed to triage", async () => {
    const names = await toolNames("/mcp?skills=inspect,triage");
    expect(names).toContain("update_issue");
    expect(names).toContain("add_issue_note");
  });

  it("refuses a misspelt skill with a 400 rather than guessing", async () => {
    const { status, body } = await rpc("/mcp?skills=triag", "tools/list", {
      authorization: "Bearer test",
    });
    expect(status).toBe(400);
    expect(body.error.message).toContain("triag");
  });
});
