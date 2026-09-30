# Container image for @sentry/mcp-vercel on Helm7.
#
# Build context is the whole repository (Helm7 uses the full clone whenever the
# Dockerfile sits in a nested workspace package). Service settings:
#   root_directory = packages/mcp-vercel   (Dockerfile path: packages/mcp-vercel/Dockerfile)
# It lives here rather than at the repository root so an upstream merge never
# collides with a root Dockerfile.
#
# Helm7's generated Dockerfile is not used: it has no corepack in its runtime
# stage and cannot install a pnpm 11 workspace. A Dockerfile in the build root
# always wins, so this one is built instead.

FROM node:22-alpine AS build

# The exact version in the root package.json "packageManager". A different pnpm
# reads pnpm-lock.yaml and pnpm-workspace.yaml (catalog:, allowBuilds) with
# different rules, and --frozen-lockfile then fails or resolves something else.
# packages/mcp-vercel/src/dockerfile.test.ts fails if the two drift.
RUN corepack enable && corepack prepare pnpm@11.8.0 --activate

ENV CI=true
WORKDIR /repo

# Only the workspace packages @sentry/mcp-vercel depends on. Copying the rest of
# the repository (the Cloudflare app, evals, docs) would put its dependencies
# in the install and its sources in a context the 2.5 GB build cap has to carry.
# patches/ is needed even though nothing here uses the patched package: the
# lockfile records the patch and pnpm refuses to install when the file is gone.
# plugins/ is read by mcp-core's generate-definitions, which its build runs.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY patches ./patches
COPY plugins ./plugins
COPY packages/mcp-server-tsconfig ./packages/mcp-server-tsconfig
COPY packages/mcp-server-mocks ./packages/mcp-server-mocks
COPY packages/mcp-core ./packages/mcp-core
COPY packages/mcp-vercel ./packages/mcp-vercel

# Same install and build steps as vercel.json, so both hosts run the same code,
# with one difference: --ignore-scripts. @ast-grep/cli (a dev-only linter that
# arrives through mcp-core) fails its postinstall on Alpine because it ships no
# musl binary, which fails the whole install. Nothing this image builds or runs
# needs a postinstall (esbuild resolves its binary without one).
RUN pnpm install --filter=@sentry/mcp-vercel... --frozen-lockfile --ignore-scripts
RUN pnpm --filter @sentry/mcp-core run build
RUN pnpm --filter @sentry/mcp-vercel run build

# mcp-core is consumed from its built dist, so the runtime needs a real copy of
# it, not a workspace symlink to a directory that will not exist: pnpm deploy.
#
# Two things about it here, both found by running it:
# - The root package.json has a "deploy" script (turbo deploy). With one
#   present pnpm 11 runs that script for `pnpm deploy` and never reaches the
#   command, so the script is dropped from this image's copy of the manifest.
# - The default (legacy) implementation re-resolves the workspace and fails on
#   the workers-oauth-provider patch, whose package is not in this install.
#   Injecting workspace packages makes it deploy from the frozen lockfile
#   instead, which is also what the install above used.
RUN node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync("package.json","utf8"));delete p.scripts.deploy;fs.writeFileSync("package.json",JSON.stringify(p,null,2))' \
 && pnpm --config.inject-workspace-packages=true --filter @sentry/mcp-vercel deploy --prod /out


FROM node:22-alpine AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0

WORKDIR /app

# node_modules, the compiled server and package.json (for "type": "module").
# Nothing else from the deploy output: no sources, no tsconfig, no pnpm.
COPY --from=build --chown=node:node /out/package.json ./package.json
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/dist ./dist

USER node
EXPOSE 3000

# Binds 0.0.0.0:$PORT itself (src/listen.ts); it does not read HOSTNAME, which
# is set above only to match the platform's convention.
CMD ["node", "dist/start.js"]
