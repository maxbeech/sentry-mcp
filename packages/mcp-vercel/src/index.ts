import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "@sentry/mcp-core/server";
import type { ServerContext } from "@sentry/mcp-core/types";
import cors from "cors";
import express, { type Request, type Response } from "express";
import {
  type OAuthStatus,
  oauthStatus,
  SENTRY_OAUTH_SCOPES,
} from "./oauth/config.js";
import { SentryOAuthProvider } from "./oauth/provider.js";
import { isSealed, open } from "./oauth/seal.js";
import { resolveGrantedSkills } from "./skills.js";

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

export interface AppOptions {
  env?: NodeJS.ProcessEnv;
  /** Sentry's OAuth endpoints are called through this; tests replace it. */
  fetchImpl?: typeof fetch;
}

/**
 * Two ways in, and the second is optional.
 *
 * 1. A raw Sentry auth token as `Authorization: Bearer <token>`, as always.
 * 2. Sign in with Sentry (OAuth), when a Sentry OAuth application is configured:
 *    the caller discovers the endpoints from a 401, registers itself, sends the
 *    person to Sentry's own consent screen, and is handed back sealed tokens
 *    that carry Sentry's (see oauth/seal.ts). Nobody pastes a token.
 *
 * Both end at the same place: a Sentry access token in `ServerContext`.
 */
export function createApp({
  env = process.env,
  fetchImpl = fetch,
}: AppOptions = {}) {
  const app = express();
  // One proxy (Vercel) sits in front of us; the OAuth routes rate-limit by client address.
  app.set("trust proxy", 1);
  app.use(cors({ exposedHeaders: ["WWW-Authenticate"] }));

  const oauth: OAuthStatus = oauthStatus(env);
  const provider =
    oauth.state === "on"
      ? new SentryOAuthProvider(oauth.config, fetchImpl)
      : null;
  const resourceMetadataUrl =
    oauth.state === "on"
      ? new URL(
          "/.well-known/oauth-protected-resource/mcp",
          oauth.config.baseUrl,
        ).href
      : null;

  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      ok: true,
      oauth:
        oauth.state === "incomplete"
          ? { state: "incomplete", missing: oauth.missing }
          : { state: oauth.state },
    });
  });

  app.get("/", (_req: Request, res: Response) => {
    res.json({
      name: "sentry-mcp-vercel",
      description:
        "Self-hosted @sentry/mcp-core with real find_projects/find_organizations pagination (getsentry/sentry-mcp#1319).",
      endpoints: { mcp: "/mcp", health: "/health" },
      signIn:
        oauth.state === "on"
          ? "OAuth (Sign in with Sentry) or a raw Sentry auth token"
          : "a raw Sentry auth token",
    });
  });

  if (oauth.state === "on" && provider) {
    const base = oauth.config.baseUrl;
    app.use(
      mcpAuthRouter({
        provider,
        issuerUrl: base,
        baseUrl: base,
        scopesSupported: [...SENTRY_OAUTH_SCOPES],
        resourceName: "Sentry",
        resourceServerUrl: new URL("/mcp", base),
      }) as unknown as express.RequestHandler,
    );
    app.get("/oauth/sentry/callback", provider.callbackHandler);
  } else if (oauth.state === "incomplete") {
    // Half a configuration must not look like no configuration.
    app.all(
      ["/authorize", "/token", "/register", "/oauth/sentry/callback"],
      (_req: Request, res: Response) => {
        res.status(503).json({
          error: "temporarily_unavailable",
          error_description: `Sign in with Sentry is not fully configured. Missing: ${oauth.missing.join(", ")}.`,
        });
      },
    );
  }

  app.use(express.json({ limit: "2mb" }));

  function bearerFrom(req: Request): string | null {
    const header = req.headers.authorization;
    if (!header) return null;
    const match = header.match(/^(?:Bearer|Sentry-Bearer)\s+(.+)$/i);
    return match?.[1]?.trim() || null;
  }

  /** The Sentry token behind a bearer: the bearer itself if raw, the sealed one's contents if ours. */
  function sentryTokenFor(
    bearer: string,
  ): { token: string } | { rejected: true } {
    if (!isSealed(bearer)) return { token: bearer };
    if (oauth.state !== "on") return { rejected: true };
    const held = open<{ sentryAccessToken: string }>(
      "access",
      bearer,
      oauth.config.secret,
    );
    return held ? { token: held.sentryAccessToken } : { rejected: true };
  }

  function unauthorized(res: Response, message: string, invalid: boolean) {
    // The challenge is what tells an OAuth-capable client where to sign in.
    if (resourceMetadataUrl) {
      res.set(
        "WWW-Authenticate",
        `Bearer${invalid ? ' error="invalid_token",' : ""} resource_metadata="${resourceMetadataUrl}"`,
      );
    }
    res
      .status(401)
      .json({ jsonrpc: "2.0", error: { code: -32001, message }, id: null });
  }

  app.post("/mcp", async (req: Request, res: Response) => {
    const bearer = bearerFrom(req);
    if (!bearer) {
      unauthorized(
        res,
        oauth.state === "on"
          ? "Missing Authorization header. Sign in with Sentry, or send Bearer <sentry token>."
          : "Missing or invalid Authorization header. Expected: Bearer <sentry token>.",
        false,
      );
      return;
    }
    const resolved = sentryTokenFor(bearer);
    if ("rejected" in resolved) {
      unauthorized(
        res,
        "The access token is invalid or has expired. Sign in again.",
        true,
      );
      return;
    }
    const accessToken = resolved.token;

    // The address says how much of this deployment the caller wants; see
    // resolveGrantedSkills. The default is every active skill, including the
    // write ones: what a write may actually do is decided by the Sentry token's
    // own scopes, and a refused write now says which scope it needed.
    const skills = resolveGrantedSkills(
      new URL(req.originalUrl, "http://localhost").searchParams,
    );
    if (!skills.ok) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32602, message: skills.message },
        id: null,
      });
      return;
    }

    const context: ServerContext = {
      accessToken,
      sentryHost: env.SENTRY_HOST?.trim() || "sentry.io",
      grantedSkills: skills.grantedSkills,
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

  return app;
}

export default createApp();
