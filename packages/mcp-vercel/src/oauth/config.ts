/**
 * OAuth is optional and says so when it is not on.
 *
 * It needs a Sentry OAuth application (client id and secret) that only the
 * account owner can create, plus a secret of our own to seal tokens with. With
 * neither, the server behaves exactly as it always did: a raw Sentry token as
 * the bearer. With only some of them it does NOT half-work: it reports which
 * are missing, because a sign-in that fails at the last step is worse than one
 * that never offers itself.
 */

/** What the OAuth grant asks Sentry for: the same set the hosted server asks for. */
export const SENTRY_OAUTH_SCOPES = [
  "org:read",
  "project:write",
  "team:write",
  "event:write",
] as const;

const DEFAULT_BASE_URL = "https://mcp-vercel-azure.vercel.app";

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  /** Seals clients, codes and tokens. */
  secret: string;
  /** Where this server is reached; the callback and the metadata are built from it. */
  baseUrl: URL;
  sentryHost: string;
}

export type OAuthStatus =
  | { state: "off" }
  | { state: "incomplete"; missing: string[] }
  | { state: "on"; config: OAuthConfig };

export function oauthStatus(env: NodeJS.ProcessEnv = process.env): OAuthStatus {
  const clientId = env.SENTRY_CLIENT_ID?.trim();
  const clientSecret = env.SENTRY_CLIENT_SECRET?.trim();
  const secret = env.OAUTH_STATE_SECRET?.trim();
  const present = [clientId, clientSecret, secret].filter(Boolean).length;
  if (present === 0) return { state: "off" };
  const missing = [
    !clientId && "SENTRY_CLIENT_ID",
    !clientSecret && "SENTRY_CLIENT_SECRET",
    !secret && "OAUTH_STATE_SECRET",
  ].filter((m): m is string => Boolean(m));
  if (missing.length > 0) return { state: "incomplete", missing };
  if (secret!.length < 32) {
    return {
      state: "incomplete",
      missing: ["OAUTH_STATE_SECRET (at least 32 characters)"],
    };
  }
  return {
    state: "on",
    config: {
      clientId: clientId!,
      clientSecret: clientSecret!,
      secret: secret!,
      baseUrl: new URL(env.OAUTH_BASE_URL?.trim() || DEFAULT_BASE_URL),
      sentryHost: env.SENTRY_HOST?.trim() || "sentry.io",
    },
  };
}
