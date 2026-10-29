ARG NODE_IMAGE=node:24.22.0-bookworm-slim
FROM ${NODE_IMAGE} AS system
RUN apt-get -o Acquire::ForceIPv4=true -o Acquire::http::Timeout=30 -o Acquire::Retries=2 update && apt-get -o Acquire::ForceIPv4=true -o Acquire::http::Timeout=30 -o Acquire::Retries=2 install -y --no-install-recommends git ca-certificates libsecret-1-0 \
    && rm -rf /var/lib/apt/lists/*
FROM system AS builder
RUN npm install --global pnpm@11.25.0
ENV T3CODE_TELEMETRY_ENABLED=false NODE_OPTIONS=--dns-result-order=ipv4first
WORKDIR /build
COPY source/ ./
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm --dir vendor/t3code --filter "@t3tools/monorepo" --filter "@t3tools/web..." --filter "t3..." --filter "@t3tools/scripts..." install --frozen-lockfile --ignore-scripts
COPY spdx/ vendor/t3code/.generated/third-party-licenses/spdx/v3.28.0/
RUN pnpm run build:ui
RUN pnpm --dir vendor/t3code/apps/server exec vp pack
RUN node scripts/bundle-agent.mjs && node scripts/bundle-customer-agent.mjs
RUN node scripts/package-t3-release.mjs /release --customer-agent-bundle /build/dist/customer-agent.zip
COPY t3-0.1.1-linux-x64.tar.gz codex-x86_64-unknown-linux-musl.tar.gz /downloads/
RUN printf '%s\n' \
    '33c43ea2f803215662f5a31fdf9e1bca86ab67cac4f2398565c2ba12e17c2185  /downloads/t3-0.1.1-linux-x64.tar.gz' \
    '26586b0d246d41a799b0ef8ee1add370f0fb0721b3709340f28db612381616ea  /downloads/codex-x86_64-unknown-linux-musl.tar.gz' | sha256sum -c - \
    && mkdir /official /codex \
    && tar -xzf /downloads/t3-0.1.1-linux-x64.tar.gz -C /official \
    && tar -xzf /downloads/codex-x86_64-unknown-linux-musl.tar.gz -C /codex \
    && cp -a /official/t3-0.1.1-linux-x64/node_modules /release/vendor/t3code/apps/server/ \
    && node scripts/verify-t3-release.mjs /release --native-source /official/t3-0.1.1-linux-x64/node_modules \
    && node /release/scripts/verify-t3-release.mjs /release \
    && node /release/scripts/verify-t3-workspace-release.mjs /release

FROM system
ARG SOURCE_COMMIT
LABEL org.opencontainers.image.title="AutoOps" \
      org.opencontainers.image.revision="${SOURCE_COMMIT}" \
      org.opencontainers.image.source="https://github.com/coco-ari/CodeMinificationRepository"
WORKDIR /app
COPY --from=builder --chown=node:node /release/ /app/
COPY --from=builder --chmod=0755 /codex/codex-x86_64-unknown-linux-musl /usr/local/bin/codex
ENV NODE_ENV=production T3CODE_TELEMETRY_ENABLED=false HOME=/data/home NODE_OPTIONS=--dns-result-order=ipv4first
USER node
CMD ["node", "agent-demo/server.mjs"]
