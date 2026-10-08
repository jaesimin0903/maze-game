# syntax=docker/dockerfile:1
#
# The game server as one long-running container (docs/deploy-monad.md).
#
#   docker build -t maze-web .
#   docker run -d --name maze-web -p 3000:3000 -v maze-data:/data \
#     --env-file .env.monad.server maze-web
#
# The server's only durable state, the event log, lives in MAZE_DATA_DIR (/data): mount a
# persistent volume there; the entry point refuses a second container on the same volume. Every
# setting comes from the environment at run time (`pnpm monad:server-env` writes the file above);
# nothing is baked into the image, and the browser reads its settings from GET /api/config.
#
# The image runs Next's standalone output: the server and only the files its trace needs, so the
# runtime stage installs no package (client-only dependencies such as the wallet SDKs stay out).

ARG NODE_VERSION=26

# ----- build: every dependency, then `next build` -----

FROM node:${NODE_VERSION}-slim AS build
# The version `packageManager` in package.json names. Recent Node images ship no corepack, and
# the corepack on npm does not support every Node version, so pnpm is installed with npm.
ARG PNPM_VERSION=10.28.1
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm install -g pnpm@${PNPM_VERSION}
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/sim/package.json packages/sim/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm install --frozen-lockfile --store-dir /pnpm/store
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN NEXT_OUTPUT=standalone pnpm --filter @maze/web build

# ----- runtime: the standalone server, its static files and nothing else -----

FROM node:${NODE_VERSION}-slim AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 MAZE_DATA_DIR=/data
# The entry point locks the volume with `flock` (util-linux, part of every Debian image).
RUN command -v flock
WORKDIR /app
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static apps/web/.next/static
COPY --from=build /app/apps/web/public apps/web/public
COPY --chmod=0755 scripts/container-start.sh /usr/local/bin/container-start
EXPOSE 3000
CMD ["container-start"]
