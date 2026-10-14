FROM node:24-alpine AS ui-build
WORKDIR /build
RUN npm install --global pnpm@11.25.0
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json vite.config.ts components.json ./
COPY web ./web
RUN pnpm run build:ui

FROM node:24-alpine
RUN apk add --no-cache git ca-certificates \
    && mkdir -p /app /data \
    && chown node:node /app /data
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --from=ui-build --chown=node:node /build/dist/web ./dist/web
COPY --chown=node:node agent ./agent
COPY --chown=node:node scripts ./scripts
RUN node scripts/bundle-agent.mjs
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080
USER node
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.mjs"]
