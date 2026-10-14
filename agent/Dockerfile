FROM docker:29-cli AS docker-cli
FROM node:24-alpine
RUN apk add --no-cache ca-certificates bash curl tar unzip util-linux && flock --version
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx
WORKDIR /agent
COPY . /agent/
ENV NODE_ENV=production CMR_AGENT_DIR=/opt/cmr-agent
ENTRYPOINT ["node", "/agent/main.mjs"]
