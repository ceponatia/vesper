# syntax=docker/dockerfile:1
ARG NODE_VERSION=22

# ---- base: pnpm via Corepack ----
FROM node:${NODE_VERSION}-slim AS base
LABEL fly_launch_runtime="Next.js"
# /app is the WORKSPACE root, not the Next project — the Next app lives at
# /app/apps/web. Keeping the operational root here is what preserves the Fly
# volume mount at /app/data and the root release/SSH commands.
WORKDIR /app
# PORT/HOSTNAME match Fly's defaults.
ENV NEXT_TELEMETRY_DISABLED=1 \
    PORT=8080 \
    HOSTNAME=0.0.0.0
# Pin to the exact version in package.json's "packageManager" so Corepack uses
# the cached pnpm at release time instead of re-downloading it.
ARG PNPM_VERSION=10.12.1
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

# ---- build: install ALL deps + Next production build ----
# pnpm installs devDependencies regardless of NODE_ENV, so next build has
# typescript/tailwind/etc. sharp ships prebuilt binaries (the "Ignored build
# scripts: sharp" warning is benign — the @img/sharp-* optional dep provides it).
FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Every workspace manifest must exist before install, or pnpm resolves the
# `workspace:*` dependencies against nothing. Only the manifests are copied here
# so editing source doesn't bust the install layer. The web app is a workspace
# now too, and it owns next/react/drizzle — omitting it would install nothing
# the application actually runs on.
COPY apps/web/package.json ./apps/web/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/image-core/package.json ./packages/image-core/
COPY packages/image-replicate/package.json ./packages/image-replicate/
COPY packages/image-sd/package.json ./packages/image-sd/
COPY packages/simulation-core/package.json ./packages/simulation-core/
RUN pnpm install --frozen-lockfile
COPY . .
# NODE_OPTIONS raises V8's old-space ceiling for the build only (inline, so the
# runner stage never inherits it). Without it a Next build worker aborts on
# `FatalProcessOutOfMemory` — V8's own heap limit, not the kernel's OOM killer
# (that would exit 137) — which is what the default cap does once the route and
# type graph passes a certain size.
#
# `pnpm run build` is the root launcher (scripts/web.mjs): it runs Next with
# apps/web as the project directory while the repository root stays the CWD.
RUN NODE_OPTIONS=--max-old-space-size=4096 pnpm run build

# ---- runner ----
# Keep the FULL dependency tree (no `pnpm prune --prod`):
# `pnpm db:migrate` runs via tsx (a devDependency) at release time.
FROM base AS runner
# DATA_ROOT is set EXPLICITLY rather than inherited from the process working
# directory. The Fly volume is mounted at /app/data, and `dataRoot()` falls back
# to `<cwd>/data` — so any future change to how the app is started could
# silently repoint the image library. Stating it here makes that impossible.
ENV NODE_ENV=production \
    DATA_ROOT=/app/data
COPY --from=build /app /app
RUN mkdir -p /app/data
EXPOSE 8080
# Boot through the root launcher with plain node — NOT through pnpm — so boot
# never invokes Corepack (no pnpm download, no npm-registry dependency at
# startup) and is instant. The launcher resolves Next from the apps/web
# workspace, since the repository root no longer depends on next itself.
# Binds to Fly's $PORT (8080), bypassing the package.json start script's -p 3200.
CMD ["sh", "-c", "node scripts/web.mjs start -H 0.0.0.0 -p ${PORT:-8080}"]
