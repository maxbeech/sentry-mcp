import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "@sentry/mcp-core/server";
import { ACTIVE_SKILLS } from "@sentry/mcp-core/skills";
import type { ServerContext } from "@sentry/mcp-core/types";
import cors from "cors";
import express, { type Request, type Response } from "express";

/**
 * A thin, stateless HTTP wrapper around @sentry/mcp-core's own tool
 * implementations -- the same code the Cloudflare-hosted mcp.sentry.dev runs,
 * minus everything specific to that deployment (its OAuth provider, KV-backed
 * rate limiting, AutoRAG docs search). Exists because mcp.sentry.dev's
 * find_projects/find_organizations hard-cap at 25 results with no cursor of
 * any kind -- a deliberate upstream choice (getsentry/sentry-mcp PR #574) --
 * and one real organization here holds 40+ projects. mcp-core is patched to
 * raise that cap to 100 and add real cursor pagination (upstreamed as
 * getsentry/sentry-mcp#1319); this is just enough server to run it, deployed
 * the same stateless-Express-on-Vercel way as this account's other MCP
 * servers (Apollo-MCP, Google-Analytics-MCP) rather than as a Cloudflare
 * Worker, since mcp-core itself has no Cloudflare-specific dependency at all.
 *
 * A fresh MCP server + transport is built on every request -- no session
 * state, matching the "create per request" shape those servers already use.
 * Auth is a raw Sentry token in the Authorization header; this server never
 * stores, validates, or refreshes it -- it is handed straight to
 * ServerContext.accessToken, and Sentry's own REST API is the one thing that
 * actually checks it, exactly like mcp.sentry.dev's own documented
 * `Sentry-Bearer` escape hatch (accepted here under either scheme word, since
 * there is no OAuth-issued token on this deployment to disambiguate from).
 */

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true });
});

app.get("/", (_req: Request, res: Response) => {
  res.json({
    name: "sentry-mcp-vercel",
    description:
      "Self-hosted @sentry/mcp-core with real find_projects/find_organizations pagination (getsentry/sentry-mcp#1319).",
    endpoints: { mcp: "/mcp", health: "/health" },
  });
});

function accessTokenFrom(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const match = header.match(/^(?:Bearer|Sentry-Bearer)\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

app.post("/mcp", async (req: Request, res: Response) => {
  const accessToken = accessTokenFrom(req);
  if (!accessToken) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: {
        code: -32001,
        message:
          "Missing or invalid Authorization header. Expected: Bearer <sentry token>.",
      },
      id: null,
    });
    return;
  }

  const context: ServerContext = {
    accessToken,
    sentryHost: process.env.SENTRY_HOST?.trim() || "sentry.io",
    // Every tool this deployment exists to run (find_organizations,
    // find_projects, search_issues, get_sentry_resource) is foundational or
    // active by default -- see ACTIVE_SKILLS's own doc comment. Nothing here
    // narrows access further, matching how mcp.sentry.dev's own direct
    // Sentry-Bearer mode defaults when no ?skills= is given.
    grantedSkills: new Set(ACTIVE_SKILLS),
    constraints: {},
    transport: "http",
  };

  const server = buildServer({ context });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  res.on("close", () => {
    transport.close();
    server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

export default app;
