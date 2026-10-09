ARG OPENTOFU_IMAGE=ghcr.io/opentofu/opentofu:1.13.1-minimal
FROM ${OPENTOFU_IMAGE} AS tofu
FROM node:22-alpine

ARG PNPM_REGISTRY=https://registry.npmjs.org
ARG PRISMA_ENGINES_MIRROR=https://registry.npmmirror.com/-/binary/prisma
ARG ALPINE_REPOSITORY=https://mirrors.aliyun.com/alpine
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV COREPACK_NPM_REGISTRY=$PNPM_REGISTRY
ENV npm_config_registry=$PNPM_REGISTRY
ENV PRISMA_ENGINES_MIRROR=$PRISMA_ENGINES_MIRROR
ENV NEXT_TELEMETRY_DISABLED=1

RUN sed -i "s|https://dl-cdn.alpinelinux.org/alpine|${ALPINE_REPOSITORY%/}|g" /etc/apk/repositories \
  && apk add --no-cache bash curl openssl libc6-compat unzip zip && corepack enable
WORKDIR /app
COPY --from=tofu /usr/local/bin/tofu /usr/local/bin/tofu
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @aliyun-cyber-range/database prisma:generate
CMD ["sh"]
