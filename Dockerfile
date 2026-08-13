# syntax=docker/dockerfile:1
ARG NODE_VERSION=22

# ---- base: pnpm via Corepack ----
FROM node:${NODE_VERSION}-slim AS base
LABEL fly_launch_runtime="Next.js"
WORKDIR /app
# HUSKY=0 stops the `prepare` git-hook script (package.json: "prepare":"husky")
# from running during install/prune — there is no .git in the image.
# PORT/HOSTNAME match Fly's defaults.
ENV NEXT_TELEMETRY_DISABLED=1 \
    HUSKY=0 \
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
# Workspace package manifests must exist before install, or pnpm resolves the
# `workspace:*` dependencies against nothing. Only the manifests are copied here
# so editing package SOURCE doesn't bust the install layer.
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/image-core/package.json ./packages/image-core/
RUN pnpm install --frozen-lockfile
COPY . .
# NODE_OPTIONS raises V8's old-space ceiling for the build only (inline, so the
# runner stage never inherits it). Without it a Next build worker aborts on
# `FatalProcessOutOfMemory` — V8's own heap limit, not the kernel's OOM killer
# (that would exit 137) — which is what the default cap does once the route and
# type graph passes a certain size.
RUN NODE_OPTIONS=--max-old-space-size=4096 pnpm run build

# ---- runner ----
# Keep the FULL dependency tree (no `pnpm prune --prod`). Two reasons:
#   1. Pruning re-runs the husky `prepare` hook after husky is gone → the build
#      failure ("husky: not found"). HUSKY=0 + no prune avoids it entirely.
#   2. `pnpm db:migrate` runs via tsx (a devDependency) at release time.
FROM base AS runner
ENV NODE_ENV=production
COPY --from=build /app /app
RUN mkdir -p /app/data
EXPOSE 8080
# Run next via node directly — NOT through pnpm — so boot never invokes Corepack
# (no pnpm download, no npm-registry dependency at startup) and is instant.
# Binds to Fly's $PORT (8080), bypassing the package.json start script's -p 3200.
CMD ["sh", "-c", "node node_modules/next/dist/bin/next start -H 0.0.0.0 -p ${PORT:-8080}"]
