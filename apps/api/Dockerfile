FROM node:22-alpine

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV NEXT_TELEMETRY_DISABLED=1

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

RUN pnpm --filter @aliyun-cyber-range/api build

EXPOSE 3001

ENV NODE_ENV=production

CMD ["sh", "-c", "pnpm --filter @aliyun-cyber-range/database prisma:migrate:deploy && pnpm --filter @aliyun-cyber-range/api start"]
