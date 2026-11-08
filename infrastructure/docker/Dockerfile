# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:26.13.0-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68
ARG CADDY_IMAGE=caddy:2.11.9-alpine@sha256:78bd35025c7ba85961dd149ae670315129954e77abe2383ac47c89106b35ade9
FROM ${NODE_IMAGE} AS build
WORKDIR /workspace
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm install -g pnpm@12.18.0 --no-audit --no-fund
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    pnpm install --frozen-lockfile
COPY apps apps
COPY packages packages
RUN pnpm build && pnpm --filter @medam/api deploy --prod /out

FROM ${NODE_IMAGE} AS api
ENV NODE_ENV=production API_HOST=0.0.0.0 API_PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /out/ /app/
COPY infrastructure/docker/api-entrypoint.mjs /usr/local/lib/medam-entrypoint.mjs
# The small launcher reads 0600 Compose secret mounts, then irrevocably drops uid/gid.
# The long-running API process runs as node (1000), never root.
ENTRYPOINT ["node", "/usr/local/lib/medam-entrypoint.mjs"]
CMD ["dist/server.js"]
EXPOSE 3000
HEALTHCHECK --interval=20s --timeout=5s --start-period=20s --retries=5 \
  CMD ["node", "--input-type=module", "-e", "const r=await fetch('http://127.0.0.1:3000/health/live');process.exit(r.ok?0:1)"]

FROM ${CADDY_IMAGE} AS edge
COPY --from=build /workspace/apps/web/dist /srv
COPY infrastructure/caddy/Caddyfile.local /etc/caddy/Caddyfile
HEALTHCHECK --interval=20s --timeout=5s --retries=5 \
  CMD wget -q -O /dev/null http://127.0.0.1:80/health/edge || exit 1
