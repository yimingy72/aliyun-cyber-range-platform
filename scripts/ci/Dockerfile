ARG OPENTOFU_IMAGE=ghcr.io/opentofu/opentofu:1.12.3-minimal
FROM ${OPENTOFU_IMAGE} AS tofu
FROM node:22-alpine

ARG PNPM_REGISTRY=https://registry.npmjs.org
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV COREPACK_NPM_REGISTRY=$PNPM_REGISTRY
ENV npm_config_registry=$PNPM_REGISTRY
ENV NEXT_TELEMETRY_DISABLED=1

RUN apk add --no-cache bash curl openssl libc6-compat unzip zip && corepack enable
WORKDIR /app
COPY --from=tofu /usr/local/bin/tofu /usr/local/bin/tofu
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @aliyun-cyber-range/database prisma:generate
CMD ["sh"]
