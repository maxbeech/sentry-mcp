import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import {
  InvalidGrantError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Request, Response } from "express";
import { type OAuthConfig, SENTRY_OAUTH_SCOPES } from "./config.js";
import { open, seal } from "./seal.js";
import {
  authorizeUrl,
  exchangeCode,
  refreshTokens,
  type SentryTokens,
  UpstreamOAuthError,
} from "./sentry-upstream.js";

/**
 * An MCP authorization server that signs the caller in to Sentry and hands back
 * its own tokens, sealed. See seal.ts for why nothing is stored.
 *
 * The flow, for a caller that has never been here:
 *   register  -> `client_id` is the sealed registration itself
 *   authorize -> bounce to Sentry's consent screen, carrying a sealed `state`
 *   callback  -> Sentry sends a code back HERE; we trade it for Sentry's tokens
 *                and send the caller onward with our own sealed code
 *   token     -> PKCE is checked, and the code becomes a sealed access token
 *                (carrying Sentry's) and a sealed refresh token
 *   refresh   -> Sentry is asked for a new pair and the caller is given both
 *
 * The caller never sees Sentry's credentials in the clear and Sentry never sees
 * the caller's redirect address.
 */

const CODE_TTL_SECONDS = 600;
const STATE_TTL_SECONDS = 600;
const REFRESH_TTL_SECONDS = 60 * 60 * 24 * 30;

interface StatePayload {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  callerState?: string;
  scopes: string[];
  resource?: string;
}

interface CodePayload extends Omit<StatePayload, "callerState"> {
  sentry: SentryTokens;
}

interface AccessPayload {
  clientId: string;
  scopes: string[];
  sentryAccessToken: string;
}

interface RefreshPayload {
  clientId: string;
  scopes: string[];
  sentryRefreshToken: string;
}

export class SentryOAuthProvider implements OAuthServerProvider {
  /** PKCE is verified by the SDK against the challenge we return from the code. */
  readonly skipLocalPkceValidation = false;

  constructor(
    private readonly config: OAuthConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get clientsStore(): OAuthRegisteredClientsStore {
    const secret = this.config.secret;
    return {
      async getClient(clientId: string) {
        const meta = open<OAuthClientInformationFull>(
          "client",
          clientId,
          secret,
        );
        return meta ? { ...meta, client_id: clientId } : undefined;
      },
      async registerClient(client: OAuthClientInformationFull) {
        // The SDK made up a client_id; ours is the whole record, sealed.
        return { ...client, client_id: seal("client", client, secret) };
      },
    };
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const state = seal(
      "state",
      {
        clientId: client.client_id,
        redirectUri: params.redirectUri,
        codeChallenge: params.codeChallenge,
        callerState: params.state,
        scopes: params.scopes?.length
          ? params.scopes
          : [...SENTRY_OAUTH_SCOPES],
        resource: params.resource?.href,
      } satisfies StatePayload,
      this.config.secret,
      STATE_TTL_SECONDS,
    );
    res.redirect(authorizeUrl(this.config, state));
  }

  /**
   * Sentry's redirect back to us. Not part of the SDK's interface: it is the
   * hop between Sentry and this server, and ends by redirecting the original
   * caller to the address it registered, with OUR code.
   */
  callbackHandler = async (req: Request, res: Response): Promise<void> => {
    const { code, state, error } = req.query as Record<
      string,
      string | undefined
    >;
    const pending = state
      ? open<StatePayload>("state", state, this.config.secret)
      : undefined;
    if (!pending) {
      res
        .status(400)
        .type("text/plain")
        .send(
          "This sign-in link is invalid or has expired. Start again from the application.",
        );
      return;
    }
    const back = new URL(pending.redirectUri);
    const fail = (name: string, description: string) => {
      back.searchParams.set("error", name);
      back.searchParams.set("error_description", description);
      if (pending.callerState)
        back.searchParams.set("state", pending.callerState);
      res.redirect(back.href);
    };
    if (error) {
      fail(
        error === "access_denied" ? "access_denied" : "server_error",
        "Sentry did not grant access.",
      );
      return;
    }
    if (!code) {
      fail("server_error", "Sentry returned no authorization code.");
      return;
    }
    let sentry: SentryTokens;
    try {
      sentry = await exchangeCode(this.config, code, this.fetchImpl);
    } catch (e) {
      fail(
        "server_error",
        e instanceof UpstreamOAuthError
          ? e.message
          : "Could not complete the sign-in with Sentry.",
      );
      return;
    }
    const { callerState, ...rest } = pending;
    back.searchParams.set(
      "code",
      seal(
        "code",
        { ...rest, sentry } satisfies CodePayload,
        this.config.secret,
        CODE_TTL_SECONDS,
      ),
    );
    if (callerState) back.searchParams.set("state", callerState);
    res.redirect(back.href);
  };

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    return this.codeFor(client, authorizationCode).codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<OAuthTokens> {
    const code = this.codeFor(client, authorizationCode);
    return this.issue(client.client_id, code.scopes, code.sentry);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
  ): Promise<OAuthTokens> {
    const held = open<RefreshPayload>(
      "refresh",
      refreshToken,
      this.config.secret,
    );
    if (!held || held.clientId !== client.client_id) {
      throw new InvalidGrantError(
        "The refresh token is invalid or has expired. Sign in again.",
      );
    }
    let sentry: SentryTokens;
    try {
      sentry = await refreshTokens(
        this.config,
        held.sentryRefreshToken,
        this.fetchImpl,
      );
    } catch (e) {
      // Sentry rotates the pair on every refresh, so a token already used (or revoked) is gone for good.
      if (
        e instanceof UpstreamOAuthError &&
        e.status >= 400 &&
        e.status < 500
      ) {
        throw new InvalidGrantError(
          "Sentry no longer accepts this sign-in. Sign in again.",
        );
      }
      throw e;
    }
    return this.issue(client.client_id, held.scopes, sentry);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const held = open<AccessPayload>("access", token, this.config.secret);
    if (!held)
      throw new InvalidTokenError(
        "The access token is invalid or has expired.",
      );
    return {
      token,
      clientId: held.clientId,
      scopes: held.scopes,
      // the sealed expiry is enforced by open(); the SDK's middleware insists on a number
      expiresAt: Math.floor(Date.now() / 1000) + 60,
      extra: { sentryAccessToken: held.sentryAccessToken },
    };
  }

  private codeFor(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): CodePayload {
    const code = open<CodePayload>(
      "code",
      authorizationCode,
      this.config.secret,
    );
    if (!code || code.clientId !== client.client_id) {
      throw new InvalidGrantError(
        "The authorization code is invalid, expired, or was issued to a different client.",
      );
    }
    return code;
  }

  private issue(
    clientId: string,
    scopes: string[],
    sentry: SentryTokens,
  ): OAuthTokens {
    const lifetime = Math.max(
      60,
      sentry.expiresAt - Math.floor(Date.now() / 1000),
    );
    return {
      access_token: seal(
        "access",
        {
          clientId,
          scopes,
          sentryAccessToken: sentry.accessToken,
        } satisfies AccessPayload,
        this.config.secret,
        lifetime,
      ),
      token_type: "Bearer",
      expires_in: lifetime,
      scope: scopes.join(" "),
      refresh_token: seal(
        "refresh",
        {
          clientId,
          scopes,
          sentryRefreshToken: sentry.refreshToken,
        } satisfies RefreshPayload,
        this.config.secret,
        REFRESH_TTL_SECONDS,
      ),
    };
  }
}
