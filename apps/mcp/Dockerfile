FROM node:22-alpine

ARG PNPM_REGISTRY=https://registry.npmmirror.com
ARG ALPINE_REPOSITORY=https://mirrors.aliyun.com/alpine
ARG PNPM_FETCH_RETRIES=10
ARG PNPM_FETCH_RETRY_MIN_TIMEOUT=2000
ARG PNPM_FETCH_RETRY_MAX_TIMEOUT=30000

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV COREPACK_NPM_REGISTRY=$PNPM_REGISTRY
ENV npm_config_registry=$PNPM_REGISTRY
ENV npm_config_fetch_retries=$PNPM_FETCH_RETRIES
ENV npm_config_fetch_retry_mintimeout=$PNPM_FETCH_RETRY_MIN_TIMEOUT
ENV npm_config_fetch_retry_maxtimeout=$PNPM_FETCH_RETRY_MAX_TIMEOUT

RUN sed -i "s|https://dl-cdn.alpinelinux.org/alpine|${ALPINE_REPOSITORY%/}|g" /etc/apk/repositories \
  && apk add --no-cache curl libc6-compat \
  && corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/mcp/package.json apps/mcp/package.json
COPY apps/api/package.json apps/api/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/platform-api-client/package.json packages/platform-api-client/package.json

RUN pnpm install --frozen-lockfile --filter @aliyun-cyber-range/mcp...

COPY . .

RUN pnpm --filter @aliyun-cyber-range/database prisma:generate

EXPOSE 8787

ENV NODE_ENV=production
ENV MCP_HOST=0.0.0.0
ENV MCP_PORT=8787

CMD ["pnpm", "--filter", "@aliyun-cyber-range/mcp", "dev"]
