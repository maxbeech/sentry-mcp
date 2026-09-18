# This is a fork

`maxbeech/sentry-mcp`, forked from [`getsentry/sentry-mcp`](https://github.com/getsentry/sentry-mcp) on 2026-09-18, purely to work around one upstream limitation:

**`find_projects`/`find_organizations`/`find_teams` hard-cap at 25 results with no cursor of any kind.** Confirmed in `getsentry/sentry-mcp`'s own source: their `RESULT_LIMIT = 25` and a deliberate design choice (PR #574 — "cap at 25 + a `query` filter" over real pagination). One real Sentry organization on this account holds 40+ projects, so ~15 were permanently undiscoverable through Contextely's Sentry connector.

## What's patched

`packages/mcp-core/src/tools/catalog/{find-projects,find-organizations,find-teams}.ts` and their backing client methods in `packages/mcp-core/src/api-client/client.ts`:

- Raised the per-call cap from 25 to 100 (Sentry's own REST `per_page` ceiling).
- Added a `cursor` input parameter and `nextCursor` output field, mirroring the exact pattern `listDashboards` already used in the same file (`getNextCursor(response.headers.get("link"))`) — this repo already had the primitive, it just wasn't wired up for these three tools.
- `hasMore` is now derived from whether the server actually returned a next-page cursor, rather than the old "request N+1, slice N" probe.

This is upstreamed as **[getsentry/sentry-mcp#1319](https://github.com/getsentry/sentry-mcp/pull/1319)**. If/when that merges and ships to `mcp.sentry.dev`, the workaround below (`packages/mcp-vercel` + Contextely's `sentry_selfhosted` preset) can be retired in favor of the official hosted server again.

## What's added

`packages/mcp-vercel/` — a new workspace package, **not** part of upstream. A thin, stateless Express server (deployed on Vercel, same shape as this account's other MCP servers — Apollo-MCP, Google-Analytics-MCP) that wraps `@sentry/mcp-core`'s own `buildServer()` in `@modelcontextprotocol/sdk`'s `StreamableHTTPServerTransport` (stateless mode). No Cloudflare dependency at all, since `mcp-core` itself has none — deliberately avoids standing up Sentry's OAuth provider, KV namespaces, or rate-limiter bindings, none of which this single-purpose deployment needs. Auth is a raw Sentry token passed straight through as `Authorization: Bearer <token>`; this server never stores, validates, or refreshes it.

Deployed at `https://mcp-vercel-azure.vercel.app/mcp` (the production alias of the Vercel project `mcp-vercel` under this account).

Wired into Contextely as the `sentry_selfhosted` connector preset (`src/lib/connectors/presets.ts`), marked `internalOnly` so it never appears in the public picker or `/integrations` page for real customers.

## Keeping this in sync with upstream

```bash
git fetch upstream
git checkout main
git merge upstream/main
```

The patch surface is small and localized (the 6 files listed above), so a conflict should be rare and easy to resolve by hand — re-apply the cap/cursor change on top of whatever upstream changed in the same tools. `packages/mcp-vercel/` is untouched by any upstream merge since it doesn't exist there.

## License

FSL-1.1-ALv2 (Sentry's Functional Source License) — see `LICENSE.md`. Internal, self-hosted use like this is a Permitted Purpose; only reselling this as a competing hosted MCP-as-a-service would not be.
