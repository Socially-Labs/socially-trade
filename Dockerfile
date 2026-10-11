# bookworm glibc selects @img/sharp-linux-x64. Alpine would select the musl build.
# No CMD and no HEALTHCHECK. Worker and ingestor do not listen, and a default role would be a second start.
# Do not set NODE_ENV in the build stage. pnpm would omit turbo and typescript.

FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN corepack enable && corepack install
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm fetch --frozen-lockfile --store-dir /pnpm/store
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline --store-dir /pnpm/store
RUN pnpm build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline --prod --store-dir /pnpm/store \
      --config.confirmModulesPurge=false

FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=build --chown=node:node /app /app
RUN chmod 755 /app/docker/socially \
 && mv /app/docker/socially /usr/local/bin/socially \
 && rmdir /app/docker
USER node
ENTRYPOINT ["socially"]
