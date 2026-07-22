FROM vdagxumcha4qdz-ghcr.xuanyuan.dev/opentofu/opentofu:1.12.3-minimal AS tofu

FROM node:22-alpine

ARG PNPM_REGISTRY=https://registry.npmmirror.com
ARG ALPINE_REPOSITORY=https://mirrors.aliyun.com/alpine
ARG PNPM_FETCH_RETRIES=10
ARG PNPM_FETCH_RETRY_MIN_TIMEOUT=2000
ARG PNPM_FETCH_RETRY_MAX_TIMEOUT=30000

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV NEXT_TELEMETRY_DISABLED=1
ENV COREPACK_NPM_REGISTRY=$PNPM_REGISTRY
ENV npm_config_registry=$PNPM_REGISTRY
ENV npm_config_fetch_retries=$PNPM_FETCH_RETRIES
ENV npm_config_fetch_retry_mintimeout=$PNPM_FETCH_RETRY_MIN_TIMEOUT
ENV npm_config_fetch_retry_maxtimeout=$PNPM_FETCH_RETRY_MAX_TIMEOUT

RUN sed -i "s|https://dl-cdn.alpinelinux.org/alpine|${ALPINE_REPOSITORY%/}|g" /etc/apk/repositories \
  && apk add --no-cache bash curl openssl libc6-compat unzip zip \
  && corepack enable

WORKDIR /app

COPY --from=tofu /usr/local/bin/tofu /usr/local/bin/tofu

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/iac-runner/package.json packages/iac-runner/package.json

RUN pnpm install --frozen-lockfile

COPY . .
COPY scripts/docker/seed-provider-mirror.sh /usr/local/bin/seed-provider-mirror.sh

RUN chmod +x /usr/local/bin/tofu /usr/local/bin/seed-provider-mirror.sh

RUN build_attempt=1; \
  while [ "$build_attempt" -le 3 ]; do \
    if pnpm --filter @aliyun-cyber-range/api build; then \
      exit 0; \
    fi; \
    if [ "$build_attempt" -eq 3 ]; then \
      exit 1; \
    fi; \
    build_attempt=$((build_attempt + 1)); \
    echo "API build failed; retrying attempt $build_attempt of 3..."; \
    sleep 5; \
  done

EXPOSE 3001

ENV NODE_ENV=production
ENV OPENTOFU_PROVIDER_MIRROR_ROOT=/var/lib/cyber-range/provider-mirror

ENTRYPOINT ["seed-provider-mirror.sh"]
CMD ["sh", "-c", "pnpm --filter @aliyun-cyber-range/database prisma:migrate:deploy && pnpm --filter @aliyun-cyber-range/api start"]
