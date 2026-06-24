FROM node:22-alpine

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV NEXT_TELEMETRY_DISABLED=1

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
