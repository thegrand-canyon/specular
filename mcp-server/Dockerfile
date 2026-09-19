# Specular remote agent server (MCP Streamable HTTP + REST). Non-custodial.
#
# Build from the REPO ROOT so the image can read src/config/*.json (the only
# source of contract addresses):
#   docker build -f mcp-server/Dockerfile -t specular-agent-api .
#   docker run -p 3400:3400 -e SPECULAR_ENABLED_NETWORKS=arc-staging specular-agent-api

FROM node:22-alpine AS build
WORKDIR /app/mcp-server
COPY mcp-server/package.json mcp-server/package-lock.json ./
RUN npm ci
COPY mcp-server/tsconfig.json ./
COPY mcp-server/scripts ./scripts
COPY mcp-server/abi ./abi
COPY mcp-server/src ./src
# ABIs are bundled in ./abi; the prebuild script keeps them if artifacts/ is absent.
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production PORT=3400 HOST=0.0.0.0
WORKDIR /app/mcp-server
# Addresses come from the repo config, mounted at the same relative path (../src/config).
COPY src/config/base-addresses.json src/config/arc-testnet-v6-addresses.json src/config/arc-mainnet-addresses.json /app/src/config/
COPY --from=build /app/mcp-server/node_modules ./node_modules
COPY --from=build /app/mcp-server/dist ./dist
COPY --from=build /app/mcp-server/abi ./abi
COPY --from=build /app/mcp-server/openapi.json ./openapi.json
COPY mcp-server/package.json ./package.json
USER node
EXPOSE 3400
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s CMD wget -qO- http://127.0.0.1:${PORT}/health || exit 1
CMD ["node", "dist/http.js"]
