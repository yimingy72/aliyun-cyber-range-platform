FROM node:22-alpine

ARG PNPM_REGISTRY=https://registry.npmmirror.com
ARG PNPM_NETWORK_CONCURRENCY=2
ARG PNPM_FETCH_RETRIES=10
ARG PNPM_FETCH_RETRY_MIN_TIMEOUT=2000
ARG PNPM_FETCH_RETRY_MAX_TIMEOUT=30000

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV NEXT_TELEMETRY_DISABLED=1
ENV COREPACK_NPM_REGISTRY=$PNPM_REGISTRY
ENV npm_config_registry=$PNPM_REGISTRY
ENV npm_config_network_concurrency=$PNPM_NETWORK_CONCURRENCY
ENV npm_config_fetch_retries=$PNPM_FETCH_RETRIES
ENV npm_config_fetch_retry_mintimeout=$PNPM_FETCH_RETRY_MIN_TIMEOUT
ENV npm_config_fetch_retry_maxtimeout=$PNPM_FETCH_RETRY_MAX_TIMEOUT

ARG NEXT_PUBLIC_API_BASE_URL=http://localhost:3001
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL

RUN apk add --no-cache curl openssl libc6-compat \
  && corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/iac-runner/package.json packages/iac-runner/package.json

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm --filter @aliyun-cyber-range/web build

EXPOSE 3000

ENV NODE_ENV=production

CMD ["pnpm", "--filter", "@aliyun-cyber-range/web", "start"]
