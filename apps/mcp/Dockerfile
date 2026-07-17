FROM node:22-alpine

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN apk add --no-cache curl libc6-compat \
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
