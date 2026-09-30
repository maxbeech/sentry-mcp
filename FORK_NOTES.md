# This is a fork

`maxbeech/sentry-mcp`, forked from [`getsentry/sentry-mcp`](https://github.com/getsentry/sentry-mcp) on 2026-09-18, to work around one upstream limitation, and since 2026-09-30 to make writing back to Sentry usable (see "Writing to Sentry" below):

**`find_projects`/`find_organizations`/`find_teams` hard-cap at 25 results with no cursor of any kind.** Confirmed in `getsentry/sentry-mcp`'s own source: their `RESULT_LIMIT = 25` and a deliberate design choice (PR #574 — "cap at 25 + a `query` filter" over real pagination). One real Sentry organization on this account holds 40+ projects, so ~15 were permanently undiscoverable through Contextely's Sentry connector.

## What's patched

`packages/mcp-core/src/tools/catalog/{find-projects,find-organizations,find-teams}.ts` and their backing client methods in `packages/mcp-core/src/api-client/client.ts`:

- Raised the per-call cap from 25 to 100 (Sentry's own REST `per_page` ceiling).
- Added a `cursor` input parameter and `nextCursor` output field, mirroring the exact pattern `listDashboards` already used in the same file (`getNextCursor(response.headers.get("link"))`) — this repo already had the primitive, it just wasn't wired up for these three tools.
- `hasMore` is now derived from whether the server actually returned a next-page cursor, rather than the old "request N+1, slice N" probe.

This is upstreamed as **[getsentry/sentry-mcp#1319](https://github.com/getsentry/sentry-mcp/pull/1319)**. If/when that merges and ships to `mcp.sentry.dev`, the workaround below (`packages/mcp-vercel` + Contextely's `sentry_selfhosted` preset) can be retired in favor of the official hosted server again.

## What's added

`packages/mcp-vercel/` — a new workspace package, **not** part of upstream. A thin, stateless Express server (deployed on Vercel, same shape as this account's other MCP servers — Apollo-MCP, Google-Analytics-MCP) that wraps `@sentry/mcp-core`'s own `buildServer()` in `@modelcontextprotocol/sdk`'s `StreamableHTTPServerTransport` (stateless mode). No Cloudflare dependency at all, since `mcp-core` itself has none — deliberately avoids standing up Sentry's OAuth provider, KV namespaces, or rate-limiter bindings, none of which this single-purpose deployment needs. Auth is a raw Sentry token passed straight through as `Authorization: Bearer <token>`; this server never stores, validates, or refreshes it.

Deployed at `https://mcp-vercel-azure.vercel.app/mcp` (the production alias of the Vercel project `mcp-vercel` under this account). It is moving to Helm7: the hostname Helm7 will serve is `https://sentry.mcp.openhelm.ai/mcp`. That is planned and not yet live. `mcp-vercel-azure.vercel.app` stays up until callers have moved (see "Running on Helm7").

Wired into Contextely as the `sentry_selfhosted` connector preset (`src/lib/connectors/presets.ts`), marked `internalOnly` so it never appears in the public picker or `/integrations` page for real customers.

## Running on Helm7

The same server also runs as a long-lived container on Helm7, from the `helm7` branch.

- **Image:** `packages/mcp-vercel/Dockerfile`, with `packages/mcp-vercel/Dockerfile.dockerignore` beside it. It installs only what `@sentry/mcp-vercel` depends on (`pnpm install --filter=@sentry/mcp-vercel... --frozen-lockfile`, the same as `vercel.json`), builds `mcp-core`, compiles `mcp-vercel` with `tsc`, and ships a `pnpm deploy --prod` copy on `node:22-alpine` as the non-root `node` user. pnpm is pinned through corepack to the root `packageManager` version; `src/dockerfile.test.ts` fails if the two drift or a `COPY` names something that is missing or ignored.
- **Service settings:** repo `maxbeech/sentry-mcp`, branch `helm7`, `root_directory` = `packages/mcp-vercel`. Helm7 then builds `packages/mcp-vercel/Dockerfile` with the whole clone as context. The Dockerfile is here, not at the repository root, so upstream merges never conflict with a root one.
- **Start:** `node dist/start.js` (`src/start.ts`). It binds `0.0.0.0` on `PORT` (Helm7 sets 3000; 3000 if unset; a malformed `PORT` is an error), answers `GET /` with 200 for the health check, and shuts down on SIGTERM.
- **Environment:** none required. `SENTRY_HOST` is optional and defaults to `sentry.io`. The Sentry token is still supplied per request as `Authorization: Bearer`, never configured on the service.
- **Client IP:** the server has no per-IP logic and no `trust proxy`, so the `X-Helm7-Client-Ip` header is not read.
- **Vercel:** `vercel.json` and `api/index.ts` are left in place so upstream merges stay clean. The Vercel project is frozen at its current deployment as a legacy alias until it is deleted; nothing on the Helm7 path depends on it.

## Writing to Sentry (2026-09-30)

Closing the loop on a reported incident is two writes: set the issue's status, and leave a note saying what shipped. Two separate things decide whether either lands, and they are easy to confuse.

**1. Which tools the server offers: skills.** `inspect` and `seer` are read-only. `triage` (`update_issue`, `add_issue_note`) and `project-management` (`create_project`, `create_dsn`, ...) are the write skills.

- **This deployment** grants every active skill by default, so the write tools are always offered. A connection can ask for less in the address: `/mcp?skills=inspect,triage` replaces the set, `/mcp?disable-skills=project-management` removes from it, the same rules as `mcp.sentry.dev`'s direct token mode. An unknown or empty skill is refused with a 400 rather than ignored, because a typo that quietly widened or emptied the grant is what a permission boundary must not absorb.
- **`mcp.sentry.dev`** (Sentry's own, OAuth) offers `triage` only if it was ticked on Sentry's consent screen. It is unticked by default, and the choice is made in the browser at sign-in, so the only way to add it is to sign in again and tick **Triage Issues**. Nothing in this fork can change that server.

**2. Whether a write lands: the Sentry token's own scopes.** This deployment never validates a token; Sentry does. `update_issue` and `add_issue_note` need `event:write`; project and team changes need `project:write` and `team:write`. A read-only token is offered the write tools and Sentry answers 403.

Two changes here make that failure usable:

- `add_issue_note` is a **top-level** tool (`surfaces.ts`). It used to be reachable only through `execute_sentry_tool`, and a caller that can only approve tools by name would have had to approve that generic executor, which can run every other write in the catalogue as well.
- A refused write now says which scope it needed. Sentry's 403 names none, so an agent could not tell "this token cannot write" from "you cannot see this project". `annotateMissingScopes` (`internal/error-handling.ts`) attaches the tool's own write scopes to the `ApiPermissionError` at the tool boundary, in both the direct path and `execute_sentry_tool`, and the formatter prints them with the two remedies (new token with that scope, or sign in again with the skill). Reads are deliberately left alone: a 403 on a read almost always means project access, which a wider token would not fix.

Files: `packages/mcp-core/src/{api-client/errors.ts,internal/error-handling.ts,server.ts,tools/surfaces.ts,tools/special/execute-tool.ts}` (plus tests), and in `packages/mcp-vercel`, `src/skills.ts` and `src/index.ts`. The wrapper now has its own tests (`pnpm --filter @sentry/mcp-vercel test`), which start the app on a real port and list tools without calling Sentry.

## Sign in with Sentry instead of pasting a token (2026-09-30)

`/mcp` accepts two kinds of bearer. A raw Sentry auth token works exactly as before. If a Sentry OAuth application is configured, the server is also an MCP authorization server, so a client such as Contextely can discover it from a 401, register itself, send the person to Sentry's own consent screen and be handed tokens, with nothing pasted. Signing in this way requests `org:read project:write team:write event:write` (the hosted server's set), so **a signed-in connection can resolve issues and leave notes with no skill to tick**; `?skills=` narrows it.

**It is off until configured, and says so.** With none of the three variables set the server behaves as it always did. With some, `/authorize`, `/token` and `/register` answer 503 naming what is missing, and `/health` reports `oauth.state` (`off`, `incomplete`, `on`). It never half-works.

One-time setup, which only the Sentry account owner can do:

1. In Sentry, create an OAuth application (User settings, API, Applications). Set its **Authorized Redirect URI** to `https://mcp-vercel-azure.vercel.app/oauth/sentry/callback`. Sentry shows a client id and client secret.
2. On the Vercel project `mcp-vercel` set `SENTRY_CLIENT_ID` and `SENTRY_CLIENT_SECRET` (production). `OAUTH_STATE_SECRET` (32+ characters, seals every token) must also be set; `OAUTH_BASE_URL` only if the address is not the alias above.
3. Redeploy. `/health` should now say `"oauth":{"state":"on"}`.

How it works, in `packages/mcp-vercel/src/oauth/`:

- **Nothing is stored.** A Vercel function keeps nothing between calls and there is no database, so a registered client, an authorization code, an access token and a refresh token are each an AES-256-GCM blob that carries its own record and expiry (`seal.ts`). They are encrypted rather than merely signed because they carry Sentry's own tokens and a code passes through a browser address bar. The kind is authenticated data, so a code cannot be used as an access token. A code is not single-use (a stateless server cannot record that it was spent); it lives ten minutes and is useless without the PKCE verifier.
- **Sentry's tokens last about thirty days and both halves rotate on refresh.** The hosted server just asks for a new sign-in after that. This one refreshes upstream and returns the new pair to the caller, so a used refresh token is dead at Sentry and here. A refresh Sentry rejects becomes `invalid_grant`, which tells the client to sign in again.
- `provider.ts` is the SDK's `OAuthServerProvider`; `sentry-upstream.ts` is the two calls to Sentry; `config.ts` decides `off`/`incomplete`/`on`.
- `oauth.test.ts` runs the whole flow against a faked Sentry: metadata, register, authorize, callback, PKCE exchange, use on `/mcp` (asserting Sentry sees the unwrapped token), refresh rotation and reuse, tampered, foreign-kind, expired and cross-client tokens, and the not-fully-configured states.

What this does NOT change: the hosted `mcp.sentry.dev` keeps its own consent screen and its untick-by-default Triage skill. This is only the fork.

## Keeping this in sync with upstream

```bash
git fetch upstream
git checkout main
git merge upstream/main
```

The patch surface is small and localized (the 6 files listed above, plus the five named under "Writing to Sentry"), so a conflict should be rare and easy to resolve by hand — re-apply the cap/cursor change on top of whatever upstream changed in the same tools. `packages/mcp-vercel/` is untouched by any upstream merge since it doesn't exist there.

## License

FSL-1.1-ALv2 (Sentry's Functional Source License) — see `LICENSE.md`. Internal, self-hosted use like this is a Permitted Purpose; only reselling this as a competing hosted MCP-as-a-service would not be.
