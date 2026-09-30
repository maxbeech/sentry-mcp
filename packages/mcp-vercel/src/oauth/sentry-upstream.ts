import type { OAuthConfig } from "./config.js";
import { SENTRY_OAUTH_SCOPES } from "./config.js";

/**
 * The two calls to Sentry's own OAuth. Sentry issues a token pair that lasts
 * about thirty days and rotates BOTH halves on refresh, so a refresh must hand
 * the caller the new pair: the old refresh token is dead the moment it is used.
 */

export interface SentryTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch seconds. */
  expiresAt: number;
  scopes: string[];
}

export class UpstreamOAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Sentry's own `error` code, e.g. invalid_grant. */
    readonly code?: string,
  ) {
    super(message);
    this.name = "UpstreamOAuthError";
  }
}

export function callbackUrl(config: OAuthConfig): string {
  return new URL("/oauth/sentry/callback", config.baseUrl).href;
}

export function authorizeUrl(config: OAuthConfig, state: string): string {
  const url = new URL(`https://${config.sentryHost}/oauth/authorize/`);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", callbackUrl(config));
  url.searchParams.set("scope", SENTRY_OAUTH_SCOPES.join(" "));
  url.searchParams.set("state", state);
  return url.href;
}

async function tokenCall(
  config: OAuthConfig,
  form: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<SentryTokens> {
  const response = await fetchImpl(
    `https://${config.sentryHost}/oauth/token/`,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": "sentry-mcp-vercel",
      },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        ...form,
      }).toString(),
    },
  );
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // not JSON: reported below with the status alone; the body may echo secrets
  }
  if (!response.ok) {
    const code = typeof body.error === "string" ? body.error : undefined;
    throw new UpstreamOAuthError(
      `Sentry refused the token request (HTTP ${response.status}${code ? `, ${code}` : ""})`,
      response.status,
      code,
    );
  }
  const access = body.access_token;
  const refresh = body.refresh_token;
  const expiresIn = body.expires_in;
  if (
    typeof access !== "string" ||
    typeof refresh !== "string" ||
    typeof expiresIn !== "number"
  ) {
    throw new UpstreamOAuthError(
      "Sentry's token response was missing the access token, refresh token or expiry",
      502,
    );
  }
  return {
    accessToken: access,
    refreshToken: refresh,
    expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
    scopes:
      typeof body.scope === "string"
        ? body.scope.split(/[\s,]+/).filter(Boolean)
        : [...SENTRY_OAUTH_SCOPES],
  };
}

export function exchangeCode(
  config: OAuthConfig,
  code: string,
  fetchImpl: typeof fetch = fetch,
) {
  return tokenCall(
    config,
    {
      grant_type: "authorization_code",
      code,
      redirect_uri: callbackUrl(config),
    },
    fetchImpl,
  );
}

export function refreshTokens(
  config: OAuthConfig,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
) {
  return tokenCall(
    config,
    { grant_type: "refresh_token", refresh_token: refreshToken },
    fetchImpl,
  );
}
