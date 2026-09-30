import { createHash, randomBytes } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "./index.js";
import { isSealed, open, seal } from "./oauth/seal.js";

/**
 * The whole sign-in, against a Sentry that is faked at the two places this
 * server talks to it. Nothing here needs a Sentry account: what is under test is
 * that the server really is an authorization server a client can complete, that
 * the tokens it issues carry Sentry's and nothing readable, and that a bad or
 * spent token is refused with the challenge that tells a client where to sign in.
 */

vi.setConfig({ testTimeout: 30_000 });

type FetchInput = Parameters<typeof fetch>[0];

const SECRET = "x".repeat(40);
const ISSUER = "https://mcp.example.test";
const REDIRECT = "http://localhost:9999/cb";
const env = {
  SENTRY_CLIENT_ID: "sentry-client-id",
  SENTRY_CLIENT_SECRET: "sentry-client-secret",
  OAUTH_STATE_SECRET: SECRET,
  OAUTH_BASE_URL: ISSUER,
} as NodeJS.ProcessEnv;

// ---- a Sentry that issues a pair, rotates it, and refuses a spent refresh token
const spentRefresh = new Set<string>();
let issued = 0;
const sentryTokenCalls: Array<Record<string, string>> = [];
const sentryApiAuth: string[] = [];

function sentryToken(body: URLSearchParams): Response {
  const form = Object.fromEntries(body.entries());
  sentryTokenCalls.push(form);
  const json = (status: number, data: unknown) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json" },
    });
  if (form.client_secret !== env.SENTRY_CLIENT_SECRET)
    return json(401, { error: "invalid_client" });
  if (form.grant_type === "authorization_code") {
    if (form.code !== "sentry-code")
      return json(400, { error: "invalid_grant" });
  } else if (form.grant_type === "refresh_token") {
    if (
      spentRefresh.has(form.refresh_token) ||
      !form.refresh_token.startsWith("sentry-refresh-")
    ) {
      return json(400, { error: "invalid_grant" });
    }
    spentRefresh.add(form.refresh_token);
  }
  issued += 1;
  return json(200, {
    access_token: `sentry-access-${issued}`,
    refresh_token: `sentry-refresh-${issued}`,
    expires_in: 2_592_000,
    scope: "org:read project:write team:write event:write",
  });
}

const fakeSentryFetch = (async (input: FetchInput, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith("https://sentry.io/oauth/token/"))
    return sentryToken(new URLSearchParams(String(init?.body)));
  throw new Error(`unexpected upstream call in test: ${url}`);
}) as typeof fetch;

let server: Server;
let base: string;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  // mcp-core calls Sentry's API through global fetch; record who it authenticates as.
  vi.spyOn(globalThis, "fetch").mockImplementation((async (
    input: FetchInput,
    init?: RequestInit,
  ) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("http://127.0.0.1")) return realFetch(input, init);
    const headers = new Headers(
      input instanceof Request ? input.headers : init?.headers,
    );
    sentryApiAuth.push(headers.get("authorization") ?? "");
    return new Response("[]", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch);
  const app = createApp({ env, fetchImpl: fakeSentryFetch });
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const b64url = (b: Buffer) => b.toString("base64url");
const pkce = () => {
  const verifier = b64url(randomBytes(32));
  return {
    verifier,
    challenge: b64url(createHash("sha256").update(verifier).digest()),
  };
};

async function register(): Promise<string> {
  const res = await realFetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "test client",
    }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

/** Drive authorize + Sentry's redirect back, return what the caller is finally sent. */
async function signIn(
  clientId: string,
  challenge: string,
  sentryCode = "sentry-code",
) {
  const auth = await realFetch(
    `${base}/authorize?` +
      new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "caller-state",
      }),
    { redirect: "manual" },
  );
  expect(auth.status).toBe(302);
  const toSentry = new URL(auth.headers.get("location")!);
  const back = await realFetch(
    `${base}/oauth/sentry/callback?${new URLSearchParams({ code: sentryCode, state: toSentry.searchParams.get("state")! })}`,
    { redirect: "manual" },
  );
  return { toSentry, back };
}

async function exchange(clientId: string, code: string, verifier: string) {
  return realFetch(`${base}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    }),
  });
}

const refresh = (clientId: string, refreshToken: string) =>
  realFetch(`${base}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    }),
  });

const mcp = (
  token: string | null,
  method = "tools/list",
  params?: unknown,
  path = "/mcp",
) =>
  realFetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });

describe("sign in with Sentry", () => {
  it("advertises itself, so a client can find where to sign in", async () => {
    const meta = (await (
      await realFetch(`${base}/.well-known/oauth-authorization-server`)
    ).json()) as Record<string, any>;
    expect(meta.authorization_endpoint).toBe(`${ISSUER}/authorize`);
    expect(meta.token_endpoint).toBe(`${ISSUER}/token`);
    expect(meta.registration_endpoint).toBe(`${ISSUER}/register`);
    expect(meta.code_challenge_methods_supported).toContain("S256");
    const resource = (await (
      await realFetch(`${base}/.well-known/oauth-protected-resource/mcp`)
    ).json()) as Record<string, any>;
    expect(resource.authorization_servers).toContain(`${ISSUER}/`);
  });

  it("answers a call with no token with a challenge that names the metadata", async () => {
    const res = await mcp(null);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(
      `resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  it("completes the whole flow and the resulting token works on /mcp as the Sentry user", async () => {
    const clientId = await register();
    expect(isSealed(clientId)).toBe(true);
    const { verifier, challenge } = pkce();
    const { toSentry, back } = await signIn(clientId, challenge);

    // what Sentry is asked for
    expect(toSentry.host).toBe("sentry.io");
    expect(toSentry.pathname).toBe("/oauth/authorize/");
    expect(toSentry.searchParams.get("client_id")).toBe(env.SENTRY_CLIENT_ID);
    expect(toSentry.searchParams.get("redirect_uri")).toBe(
      `${ISSUER}/oauth/sentry/callback`,
    );
    expect(toSentry.searchParams.get("scope")).toBe(
      "org:read project:write team:write event:write",
    );

    // where the caller is sent: its own address, with our sealed code and its own state back
    expect(back.status).toBe(302);
    const final = new URL(back.headers.get("location")!);
    expect(`${final.origin}${final.pathname}`).toBe(REDIRECT);
    expect(final.searchParams.get("state")).toBe("caller-state");
    const code = final.searchParams.get("code")!;
    expect(isSealed(code)).toBe(true);
    expect(code).not.toContain("sentry-access"); // sealed, never readable

    const tokenRes = await exchange(clientId, code, verifier);
    expect(tokenRes.status).toBe(200);
    const tokens = (await tokenRes.json()) as Record<string, any>;
    expect(tokens.token_type.toLowerCase()).toBe("bearer");
    expect(tokens.expires_in).toBeGreaterThan(86_400);
    expect(tokens.access_token).not.toContain("sentry-access");
    expect(tokens.refresh_token).not.toContain("sentry-refresh");

    expect((await mcp(tokens.access_token)).status).toBe(200);

    sentryApiAuth.length = 0;
    const call = await mcp(tokens.access_token, "tools/call", {
      name: "find_organizations",
      arguments: {},
    });
    expect(call.status).toBe(200);
    expect(sentryApiAuth.length).toBeGreaterThan(0);
    expect(
      sentryApiAuth.every((h) => h.startsWith("Bearer sentry-access-")),
    ).toBe(true);
  });

  it("refuses a code presented with the wrong PKCE verifier", async () => {
    const clientId = await register();
    const { challenge } = pkce();
    const { back } = await signIn(clientId, challenge);
    const code = new URL(back.headers.get("location")!).searchParams.get(
      "code",
    )!;
    const res = await exchange(clientId, code, b64url(randomBytes(32)));
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe("invalid_grant");
  });

  it("refuses a code that was issued to a different client", async () => {
    const a = await register();
    const b = await register();
    const { verifier, challenge } = pkce();
    const { back } = await signIn(a, challenge);
    const code = new URL(back.headers.get("location")!).searchParams.get(
      "code",
    )!;
    expect((await exchange(b, code, verifier)).status).toBe(400);
  });

  it("sends the caller back with access_denied when Sentry refuses", async () => {
    const clientId = await register();
    const { challenge } = pkce();
    const auth = await realFetch(
      `${base}/authorize?` +
        new URLSearchParams({
          response_type: "code",
          client_id: clientId,
          redirect_uri: REDIRECT,
          code_challenge: challenge,
          code_challenge_method: "S256",
          state: "s",
        }),
      { redirect: "manual" },
    );
    const state = new URL(auth.headers.get("location")!).searchParams.get(
      "state",
    )!;
    const back = await realFetch(
      `${base}/oauth/sentry/callback?${new URLSearchParams({ error: "access_denied", state })}`,
      { redirect: "manual" },
    );
    const final = new URL(back.headers.get("location")!);
    expect(final.searchParams.get("error")).toBe("access_denied");
    expect(final.searchParams.get("state")).toBe("s");
  });

  it("tells the caller when Sentry rejects the code it was given", async () => {
    const clientId = await register();
    const { challenge } = pkce();
    const { back } = await signIn(
      clientId,
      challenge,
      "a-code-sentry-never-issued",
    );
    const final = new URL(back.headers.get("location")!);
    expect(final.searchParams.get("error")).toBe("server_error");
    expect(final.searchParams.get("code")).toBeNull();
  });

  it("rejects a callback whose state was not issued here or has been altered", async () => {
    const res = await realFetch(
      `${base}/oauth/sentry/callback?code=x&state=smcp_s1.bm90LXJlYWw`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(400);
  });

  it("rotates the pair on refresh and refuses the spent refresh token", async () => {
    const clientId = await register();
    const { verifier, challenge } = pkce();
    const { back } = await signIn(clientId, challenge);
    const first = (await (
      await exchange(
        clientId,
        new URL(back.headers.get("location")!).searchParams.get("code")!,
        verifier,
      )
    ).json()) as any;

    const res = await refresh(clientId, first.refresh_token);
    expect(res.status).toBe(200);
    const second = (await res.json()) as any;
    expect(second.access_token).not.toBe(first.access_token);
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect((await mcp(second.access_token)).status).toBe(200);

    // Sentry killed the old pair when it issued the new one
    const again = await refresh(clientId, first.refresh_token);
    expect(again.status).toBe(400);
    expect(((await again.json()) as any).error).toBe("invalid_grant");
  });

  it("refuses a refresh token that belongs to another client", async () => {
    const a = await register();
    const b = await register();
    const { verifier, challenge } = pkce();
    const { back } = await signIn(a, challenge);
    const tokens = (await (
      await exchange(
        a,
        new URL(back.headers.get("location")!).searchParams.get("code")!,
        verifier,
      )
    ).json()) as any;
    expect((await refresh(b, tokens.refresh_token)).status).toBe(400);
  });

  it("refuses an altered or foreign-kind token with the challenge", async () => {
    const clientId = await register();
    const { verifier, challenge } = pkce();
    const { back } = await signIn(clientId, challenge);
    const tokens = (await (
      await exchange(
        clientId,
        new URL(back.headers.get("location")!).searchParams.get("code")!,
        verifier,
      )
    ).json()) as any;

    const altered = tokens.access_token.slice(0, -4) + "AAAA";
    const res = await mcp(altered);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("invalid_token");

    // a refresh token is not an access token
    expect((await mcp(tokens.refresh_token)).status).toBe(401);
    // nor is one sealed under a different secret
    expect(
      (
        await mcp(
          seal(
            "access",
            { clientId, scopes: [], sentryAccessToken: "x" },
            "y".repeat(40),
            600,
          ),
        )
      ).status,
    ).toBe(401);
  });

  it("refuses an expired token", async () => {
    const expired = seal(
      "access",
      { clientId: "c", scopes: [], sentryAccessToken: "x" },
      SECRET,
      -5,
    );
    expect((await mcp(expired)).status).toBe(401);
  });

  it("still accepts a raw Sentry token exactly as before", async () => {
    sentryApiAuth.length = 0;
    const res = await mcp("sntrys_raw_token", "tools/call", {
      name: "find_organizations",
      arguments: {},
    });
    expect(res.status).toBe(200);
    expect(sentryApiAuth.every((h) => h === "Bearer sntrys_raw_token")).toBe(
      true,
    );
  });

  it("keeps the skills narrowing working for a signed-in caller", async () => {
    const clientId = await register();
    const { verifier, challenge } = pkce();
    const { back } = await signIn(clientId, challenge);
    const tokens = (await (
      await exchange(
        clientId,
        new URL(back.headers.get("location")!).searchParams.get("code")!,
        verifier,
      )
    ).json()) as any;
    const res = await mcp(
      tokens.access_token,
      "tools/list",
      undefined,
      "/mcp?skills=inspect",
    );
    const text = await res.text();
    expect(text).toContain("search_issues");
    expect(text).not.toContain("update_issue");
  });
});

describe("the sealing", () => {
  it("never yields a payload for another kind, another secret or a tampered blob", () => {
    const t = seal("code", { a: 1 }, SECRET, 60);
    expect(open("code", t, SECRET)).toEqual({ a: 1 });
    expect(open("access", t, SECRET)).toBeUndefined();
    expect(open("code", t, "z".repeat(40))).toBeUndefined();
    expect(open("code", t.slice(0, -2) + "xx", SECRET)).toBeUndefined();
    expect(open("code", "smcp_c1.", SECRET)).toBeUndefined();
  });
});

describe("a deployment that is not fully configured", () => {
  async function appWith(e: NodeJS.ProcessEnv) {
    const app = createApp({ env: e, fetchImpl: fakeSentryFetch });
    let s!: Server;
    await new Promise<void>((resolve) => {
      s = app.listen(0, "127.0.0.1", () => resolve());
    });
    const b = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    return { b, close: () => new Promise<void>((r) => s.close(() => r())) };
  }

  it("with nothing set offers no sign-in and behaves as it always did", async () => {
    const { b, close } = await appWith({} as NodeJS.ProcessEnv);
    expect((await realFetch(`${b}/register`, { method: "POST" })).status).toBe(
      404,
    );
    const res = await realFetch(`${b}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBeNull();
    expect(
      ((await (await realFetch(`${b}/health`)).json()) as any).oauth.state,
    ).toBe("off");
    await close();
  });

  it("with some of it set says what is missing instead of half-working", async () => {
    const { b, close } = await appWith({
      SENTRY_CLIENT_ID: "id",
    } as NodeJS.ProcessEnv);
    const res = await realFetch(`${b}/authorize`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as any;
    expect(body.error_description).toContain("SENTRY_CLIENT_SECRET");
    expect(body.error_description).toContain("OAUTH_STATE_SECRET");
    const health = (await (await realFetch(`${b}/health`)).json()) as any;
    expect(health.oauth).toEqual({
      state: "incomplete",
      missing: ["SENTRY_CLIENT_SECRET", "OAUTH_STATE_SECRET"],
    });
    await close();
  });

  it("refuses a sealing secret that is too short", async () => {
    const { b, close } = await appWith({
      ...env,
      OAUTH_STATE_SECRET: "short",
    } as NodeJS.ProcessEnv);
    expect(
      ((await (await realFetch(`${b}/health`)).json()) as any).oauth.state,
    ).toBe("incomplete");
    await close();
  });
});
