# The orchestrator and the GTM MCP server: TypeScript bundled with esbuild into one file per service.
#   docker build -f deploy/docker/node.Dockerfile --build-arg SERVICE=orchestrator .
#   docker build -f deploy/docker/node.Dockerfile --build-arg SERVICE=mcp-server .
FROM node:22.11-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm ci --no-audit --no-fund
ARG SERVICE
RUN if [ "$SERVICE" = "orchestrator" ]; then npm -w @revops/console run build; else mkdir -p apps/console/dist; fi
RUN npx esbuild packages/${SERVICE}/src/main.ts --bundle --platform=node --format=esm --target=node22 \
      --outfile=/out/main.mjs --log-level=warning \
      --banner:js="import {createRequire as __cr} from 'module';const require=__cr(import.meta.url);"

FROM node:22.11-bookworm-slim
ENV NODE_ENV=production REVOPS_ROOT=/app PORT=8080
WORKDIR /app
COPY --from=build /out/main.mjs ./main.mjs
COPY --from=build /src/apps/console/dist ./apps/console/dist
COPY config ./config
COPY docs/playbooks ./docs/playbooks
USER node
EXPOSE 8080
CMD ["node", "main.mjs"]
