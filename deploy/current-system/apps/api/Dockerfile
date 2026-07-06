FROM vdagxumcha4qdz-ghcr.xuanyuan.run/opentofu/opentofu:1.12.3-minimal AS tofu

FROM node:22-alpine

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV NEXT_TELEMETRY_DISABLED=1

RUN apk add --no-cache bash curl openssl libc6-compat unzip zip \
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
COPY infra/opentofu/examples/alicloud-enterprise-range/.terraform/providers/registry.opentofu.org/aliyun/alicloud/1.282.0/linux_amd64/terraform-provider-alicloud_v1.282.0 /opt/provider-seed/terraform-provider-alicloud_v1.282.0
COPY deploy/current-system/scripts/docker/seed-provider-mirror.sh /usr/local/bin/seed-provider-mirror.sh

RUN chmod +x /usr/local/bin/tofu /usr/local/bin/seed-provider-mirror.sh

RUN pnpm --filter @aliyun-cyber-range/api build

EXPOSE 3001

ENV NODE_ENV=production
ENV OPENTOFU_PROVIDER_MIRROR_ROOT=/var/lib/cyber-range/provider-mirror

ENTRYPOINT ["seed-provider-mirror.sh"]
CMD ["sh", "-c", "pnpm --filter @aliyun-cyber-range/database prisma:migrate:deploy && pnpm --filter @aliyun-cyber-range/api start"]
