# 平台 Bootstrap 实施计划

> **历史计划说明**
>
> - 本文件记录的是仓库最早期的工程 bootstrap 阶段，主要用于回溯工作区、API、Web、Prisma 的初始搭建过程。
> - 它不是当前执行基线，也不应用于继续推进企业网络型综合靶场主线。
> - 当前有效文档请优先阅读：
>   - [2026-06-23-cloud-cyber-range-saas-design.md](/Users/yym/Documents/阿里云For综合靶场竞赛平台/docs/superpowers/specs/2026-06-23-cloud-cyber-range-saas-design.md)
>   - [2026-06-23-cloud-cyber-range-saas-implementation-plan.md](/Users/yym/Documents/阿里云For综合靶场竞赛平台/docs/superpowers/plans/2026-06-23-cloud-cyber-range-saas-implementation-plan.md)
>   - [2026-06-23-enterprise-range-bootstrap-plan.md](/Users/yym/Documents/阿里云For综合靶场竞赛平台/docs/superpowers/plans/2026-06-23-enterprise-range-bootstrap-plan.md)

> **面向代理执行者：** 必需子技能：使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 按任务逐步实现本计划。步骤使用复选框（`- [ ]`）语法进行跟踪。

**目标：** 构建平台第一条可运行的纵向切片：一个 monorepo 工作区、一个可运行的 NestJS API 健康检查接口、一个最小可用的 Next.js 运维首页，以及一个通过校验的 PostgreSQL/Prisma bootstrap 包。

**架构：** 保持仓库为模块化 monorepo，`apps/` 用于承载运行时应用表面，`packages/` 用于承载共享代码或靠近基础设施的代码。将 bootstrap 视为一条轻量纵向切片：先验证 workspace 连接是否正确，再补齐 API 行为，再补齐 Web 行为，最后补齐数据库与 bootstrap 配置校验。

**技术栈：** pnpm workspace、TypeScript、NestJS、Next.js App Router、Vitest、Jest、Docker Compose、PostgreSQL、Prisma

---

## 范围检查

完整规格覆盖了多个相互独立的子系统：admin 产品面、领域模型、编排引擎、IaC 执行器、镜像流水线和视觉系统。本计划有意只覆盖第一个可执行子项目：

- monorepo bootstrap
- API 健康检查接口
- Web bootstrap 页面
- PostgreSQL + Prisma bootstrap 连线

后续计划应继续覆盖：

- 比赛、队伍、模板 CRUD
- 靶场实例与供应作业
- OpenTofu 执行器
- 编排器状态机

## 文件结构

### 根工作区文件

- 新建：`package.json`
  职责：提供工作区级开发、构建、测试和数据库生命周期脚本
- 新建：`pnpm-workspace.yaml`
  职责：声明 `apps/*` 与 `packages/*` 包根目录
- 新建：`tsconfig.base.json`
  职责：提供共享的 TypeScript 编译默认配置
- 新建：`.env.example`
  职责：记录本地开发所需环境变量
- 新建：`docker-compose.yml`
  职责：提供本地 PostgreSQL bootstrap
- 新建：`test/workspace-smoke.test.mjs`
  职责：对根工作区契约进行 smoke 校验

### API 文件

- 新建：`apps/api/package.json`
  职责：定义 API 依赖与脚本
- 新建：`apps/api/tsconfig.json`
  职责：定义 API 的 TypeScript 配置
- 新建：`apps/api/tsconfig.build.json`
  职责：定义仅用于构建的 API TypeScript 配置
- 新建：`apps/api/jest.config.js`
  职责：定义 API 测试运行器配置
- 新建：`apps/api/src/app.controller.ts`
  职责：承载 bootstrap 阶段的 HTTP 接口
- 新建：`apps/api/src/app.module.ts`
  职责：承载 bootstrap 模块装配
- 新建：`apps/api/src/main.ts`
  职责：负责 Nest 应用启动
- 新建：`apps/api/test/health.e2e-spec.ts`
  职责：先失败后通过的健康检查接口契约测试

### Web 文件

- 新建：`apps/web/package.json`
  职责：定义 Web 依赖与脚本
- 新建：`apps/web/tsconfig.json`
  职责：定义 Next.js TypeScript 配置
- 新建：`apps/web/next-env.d.ts`
  职责：提供 Next.js 自动生成的类型引用
- 新建：`apps/web/vitest.config.ts`
  职责：定义 jsdom 测试运行器配置
- 新建：`apps/web/app/layout.tsx`
  职责：定义根文档壳层与元数据
- 新建：`apps/web/app/page.tsx`
  职责：定义面向运维方的 bootstrap 首页
- 新建：`apps/web/app/page.test.tsx`
  职责：先失败后通过的首页行为测试
- 新建：`apps/web/app/globals.css`
  职责：定义 bootstrap 页面的最小视觉系统

### 数据库包文件

- 新建：`packages/database/package.json`
  职责：定义 Prisma 包脚本与依赖
- 新建：`packages/database/prisma/schema.prisma`
  职责：定义 bootstrap 数据源与 client 生成器
- 新建：`packages/database/test/schema-config.test.mjs`
  职责：校验 Prisma bootstrap 契约与环境变量约定

## 任务 1：建立根工作区契约

**文件：**
- 新建：`test/workspace-smoke.test.mjs`
- 新建：`package.json`
- 新建：`pnpm-workspace.yaml`
- 新建：`tsconfig.base.json`

- [ ] **步骤 1：先写会失败的工作区 smoke 测试**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('root workspace declares scripts and package globs', () => {
  const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const workspaceYaml = fs.readFileSync(new URL('../pnpm-workspace.yaml', import.meta.url), 'utf8');

  assert.equal(packageJson.private, true);
  assert.equal(typeof packageJson.scripts.dev, 'string');
  assert.equal(typeof packageJson.scripts.build, 'string');
  assert.equal(typeof packageJson.scripts.test, 'string');
  assert.match(workspaceYaml, /apps\/\*/);
  assert.match(workspaceYaml, /packages\/\*/);
});
```

- [ ] **步骤 2：运行 smoke 测试并确认它失败**

执行：

```bash
node --test test/workspace-smoke.test.mjs
```

预期：

- FAIL，因为 `package.json` 和 `pnpm-workspace.yaml` 还不存在

- [ ] **步骤 3：写入最小可用的根工作区文件**

`package.json`

```json
{
  "name": "aliyun-cyber-range-platform",
  "private": true,
  "packageManager": "pnpm@10.32.1",
  "scripts": {
    "dev": "pnpm --parallel --stream --filter @aliyun-cyber-range/api --filter @aliyun-cyber-range/web dev",
    "build": "pnpm -r build",
    "test": "pnpm -r test && node --test test/workspace-smoke.test.mjs",
    "verify:bootstrap": "pnpm test && pnpm build && docker compose config",
    "db:up": "docker compose up -d postgres",
    "db:down": "docker compose down",
    "db:logs": "docker compose logs -f postgres"
  }
}
```

`pnpm-workspace.yaml`

```yaml
packages:
  - apps/*
  - packages/*
```

`tsconfig.base.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "moduleResolution": "node",
    "strict": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "baseUrl": "."
  }
}
```

- [ ] **步骤 4：重新运行工作区 smoke 测试**

执行：

```bash
node --test test/workspace-smoke.test.mjs
```

预期：

- PASS

- [ ] **步骤 5：提交根工作区契约**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json test/workspace-smoke.test.mjs
git commit -m "chore: establish workspace bootstrap"
```

## 任务 2：补齐并通过 API 健康检查接口

**文件：**
- 新建：`apps/api/package.json`
- 新建：`apps/api/tsconfig.json`
- 新建：`apps/api/tsconfig.build.json`
- 新建：`apps/api/jest.config.js`
- 新建：`apps/api/test/health.e2e-spec.ts`
- 新建：`apps/api/src/app.controller.ts`
- 新建：`apps/api/src/app.module.ts`
- 新建：`apps/api/src/main.ts`

- [ ] **步骤 1：先写会失败的 API 健康检查测试**

`apps/api/test/health.e2e-spec.ts`

```ts
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';

describe('Health endpoint', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule]
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns service health metadata', async () => {
    await request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect({
        status: 'ok',
        service: 'api'
      });
  });
});
```

- [ ] **步骤 2：运行 API 测试并确认它失败**

执行：

```bash
pnpm install
pnpm --filter @aliyun-cyber-range/api test -- health.e2e-spec.ts
```

预期：

- FAIL，表现为 `404 Not Found`，或在 API 文件尚未存在时出现模块 bootstrap 失败

- [ ] **步骤 3：写入最小可用的 API 实现**

`apps/api/package.json`

```json
{
  "name": "@aliyun-cyber-range/api",
  "private": true,
  "scripts": {
    "dev": "tsx watch src/main.ts",
    "build": "tsc -p tsconfig.build.json",
    "start": "node dist/main.js",
    "test": "jest --runInBand"
  },
  "dependencies": {
    "@nestjs/common": "^11.1.8",
    "@nestjs/core": "^11.1.8",
    "@nestjs/platform-express": "^11.1.8",
    "reflect-metadata": "^0.2.2",
    "rxjs": "^7.8.2"
  },
  "devDependencies": {
    "@nestjs/testing": "^11.1.8",
    "@types/express": "^5.0.3",
    "@types/jest": "^30.0.0",
    "@types/node": "^24.3.0",
    "@types/supertest": "^6.0.3",
    "jest": "^30.0.5",
    "supertest": "^7.1.4",
    "ts-jest": "^29.4.1",
    "tsx": "^4.20.5",
    "typescript": "^5.9.2"
  }
}
```

`apps/api/tsconfig.json`

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "types": ["node", "jest"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

`apps/api/tsconfig.build.json`

```json
{
  "extends": "./tsconfig.json",
  "exclude": ["test/**/*.ts", "dist", "node_modules"]
}
```

`apps/api/jest.config.js`

```js
module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  testRegex: '.*\\.e2e-spec\\.ts$',
  moduleFileExtensions: ['js', 'json', 'ts'],
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest'
  }
};
```

`apps/api/src/app.controller.ts`

```ts
import { Controller, Get } from '@nestjs/common';

@Controller()
export class AppController {
  @Get('health')
  getHealth() {
    return {
      status: 'ok',
      service: 'api'
    };
  }
}
```

`apps/api/src/app.module.ts`

```ts
import { Module } from '@nestjs/common';

import { AppController } from './app.controller';

@Module({
  controllers: [AppController]
})
export class AppModule {}
```

`apps/api/src/main.ts`

```ts
import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(process.env.API_PORT ?? 3001);
}

void bootstrap();
```

- [ ] **步骤 4：重新运行 API 测试并确认通过**

执行：

```bash
pnpm --filter @aliyun-cyber-range/api test -- health.e2e-spec.ts
```

预期：

- PASS

- [ ] **步骤 5：提交 API bootstrap 切片**

```bash
git add apps/api
git commit -m "feat: add api health endpoint bootstrap"
```

## 任务 3：补齐并通过运维首页

**文件：**
- 新建：`apps/web/package.json`
- 新建：`apps/web/tsconfig.json`
- 新建：`apps/web/next-env.d.ts`
- 新建：`apps/web/vitest.config.ts`
- 新建：`apps/web/app/page.test.tsx`
- 新建：`apps/web/app/layout.tsx`
- 新建：`apps/web/app/page.tsx`
- 新建：`apps/web/app/globals.css`

- [ ] **步骤 1：先写会失败的 Web 页面测试**

`apps/web/app/page.test.tsx`

```tsx
import { render, screen } from '@testing-library/react';

import HomePage from './page';

describe('HomePage', () => {
  it('shows the platform value proposition', () => {
    render(<HomePage />);

    expect(screen.getByRole('heading', { name: /cyber range control center/i }).textContent).toBe(
      'Cyber Range Control Center'
    );
  });
});
```

- [ ] **步骤 2：运行 Web 测试并确认它失败**

执行：

```bash
pnpm --filter @aliyun-cyber-range/web test -- page.test.tsx
```

预期：

- FAIL，因为页面尚未渲染预期标题

- [ ] **步骤 3：写入最小可用的 Web 实现**

`apps/web/package.json`

```json
{
  "name": "@aliyun-cyber-range/web",
  "private": true,
  "scripts": {
    "dev": "next dev -p ${WEB_PORT:-3000}",
    "build": "next build",
    "start": "next start -p ${WEB_PORT:-3000}",
    "test": "vitest run"
  },
  "dependencies": {
    "next": "^15.5.2",
    "react": "^19.1.1",
    "react-dom": "^19.1.1"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.8.0",
    "@testing-library/react": "^16.3.0",
    "@types/node": "^24.3.0",
    "@types/react": "^19.1.10",
    "@types/react-dom": "^19.1.7",
    "jsdom": "^26.1.0",
    "typescript": "^5.9.2",
    "vitest": "^3.2.4"
  }
}
```

`apps/web/tsconfig.json`

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "esnext",
    "moduleResolution": "bundler",
    "jsx": "preserve",
    "lib": ["dom", "dom.iterable", "es2022"],
    "allowJs": false,
    "incremental": true,
    "isolatedModules": true,
    "noEmit": true,
    "plugins": [
      {
        "name": "next"
      }
    ]
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx"],
  "exclude": ["node_modules"]
}
```

`apps/web/next-env.d.ts`

```ts
/// <reference types="next" />
/// <reference types="next/image-types/global" />

// This file is auto-generated by Next.js and should not be edited.
```

`apps/web/vitest.config.ts`

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom'
  }
});
```

`apps/web/app/layout.tsx`

```tsx
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './globals.css';

export const metadata: Metadata = {
  title: 'Cyber Range Control Center',
  description: 'Alibaba Cloud cyber range competition platform'
};

type RootLayoutProps = {
  children: ReactNode;
};

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
```

`apps/web/app/page.tsx`

```tsx
export default function HomePage() {
  return (
    <main className="page-shell">
      <section className="hero-card">
        <p className="eyebrow">Alibaba Cloud Cyber Range</p>
        <h1>Cyber Range Control Center</h1>
        <p className="description">
          A control surface for competition operators to create, observe, and retire per-team VPC ranges on Alibaba
          Cloud.
        </p>
      </section>
    </main>
  );
}
```

`apps/web/app/globals.css`

```css
html,
body {
  margin: 0;
  min-height: 100%;
  font-family: "IBM Plex Sans", "PingFang SC", "Helvetica Neue", sans-serif;
  background: linear-gradient(180deg, #f7f4ef 0%, #eef3f0 100%);
  color: #183230;
}

* {
  box-sizing: border-box;
}

.page-shell {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 40px 20px;
}

.hero-card {
  width: min(880px, 100%);
  padding: 48px;
  border-radius: 28px;
  background: rgba(255, 255, 255, 0.82);
  border: 1px solid rgba(58, 84, 80, 0.12);
  box-shadow: 0 24px 60px rgba(39, 69, 66, 0.08);
}

.eyebrow {
  margin: 0 0 12px;
  font-size: 12px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: #56716d;
}

.hero-card h1 {
  margin: 0;
  max-width: 14ch;
  font-size: clamp(40px, 6vw, 68px);
  line-height: 0.98;
}

.description {
  margin: 20px 0 0;
  max-width: 52ch;
  font-size: 18px;
  line-height: 1.7;
  color: #45605c;
}
```

- [ ] **步骤 4：重新运行 Web 测试并确认通过**

执行：

```bash
pnpm --filter @aliyun-cyber-range/web test -- page.test.tsx
```

预期：

- PASS

- [ ] **步骤 5：提交 Web bootstrap 切片**

```bash
git add apps/web
git commit -m "feat: add operator bootstrap homepage"
```

## 任务 4：校验 PostgreSQL 与 Prisma bootstrap 连线

**文件：**
- 新建：`.env.example`
- 新建：`docker-compose.yml`
- 新建：`packages/database/package.json`
- 新建：`packages/database/prisma/schema.prisma`
- 新建：`packages/database/test/schema-config.test.mjs`

- [ ] **步骤 1：先写会失败的数据库 bootstrap 测试**

`packages/database/test/schema-config.test.mjs`

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('database bootstrap exposes postgres + prisma contract', () => {
  const envExample = fs.readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8');
  const schema = fs.readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

  assert.match(envExample, /^DATABASE_URL=/m);
  assert.match(schema, /provider\\s*=\\s*"postgresql"/);
  assert.equal(typeof pkg.scripts['prisma:generate'], 'string');
});
```

- [ ] **步骤 2：运行数据库 bootstrap 测试并确认它失败**

执行：

```bash
node --test packages/database/test/schema-config.test.mjs
```

预期：

- FAIL，因为环境文件、schema 或包契约缺失

- [ ] **步骤 3：写入最小可用的数据库 bootstrap 文件**

`.env.example`

```env
NODE_ENV=development

WEB_PORT=3000
API_PORT=3001

POSTGRES_DB=cyber_range
POSTGRES_USER=postgres
POSTGRES_PASSWORD=postgres
POSTGRES_PORT=5432

DATABASE_URL=postgresql://postgres:postgres@localhost:5432/cyber_range?schema=public
```

`docker-compose.yml`

```yaml
services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: ${POSTGRES_DB:-cyber_range}
      POSTGRES_USER: ${POSTGRES_USER:-postgres}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-postgres}
    ports:
      - "${POSTGRES_PORT:-5432}:5432"
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER:-postgres} -d ${POSTGRES_DB:-cyber_range}"]
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  postgres-data:
```

`packages/database/package.json`

```json
{
  "name": "@aliyun-cyber-range/database",
  "private": true,
  "scripts": {
    "prisma:generate": "prisma generate",
    "prisma:migrate:dev": "prisma migrate dev",
    "test": "DATABASE_URL=postgresql://postgres:postgres@localhost:5432/cyber_range?schema=public prisma validate && node --test test/schema-config.test.mjs"
  },
  "dependencies": {
    "@prisma/client": "^6.15.0"
  },
  "devDependencies": {
    "prisma": "^6.15.0"
  }
}
```

`packages/database/prisma/schema.prisma`

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

- [ ] **步骤 4：运行数据库 bootstrap 校验**

执行：

```bash
pnpm --filter @aliyun-cyber-range/database test
docker compose config
```

预期：

- 数据库 bootstrap 测试 PASS
- `docker compose config` 成功退出并渲染出合法配置

- [ ] **步骤 5：提交数据库 bootstrap 切片**

```bash
git add .env.example docker-compose.yml packages/database
git commit -m "chore: add postgres and prisma bootstrap wiring"
```

## 任务 5：整体验证整个 bootstrap 切片

**文件：**
- 修改：`package.json`
- 修改：`apps/api/package.json`
- 修改：`apps/web/package.json`
- 修改：`packages/database/package.json`

- [ ] **步骤 1：写出会失败的全量 bootstrap 验证清单**

在你的工作笔记里创建一份本地清单，并把下面这些命令视为红灯态验证命令：

```text
1. pnpm install
2. pnpm test
3. pnpm build
4. pnpm verify:bootstrap
5. docker compose config
6. pnpm --filter @aliyun-cyber-range/database test
```

- [ ] **步骤 2：运行全量验证以识别失败项**

执行：

```bash
pnpm install
pnpm test
pnpm build
pnpm verify:bootstrap
docker compose config
pnpm --filter @aliyun-cyber-range/database test
```

预期：

- 剩余失败项应当都是具体的依赖或配置不匹配，而不是模糊的 bootstrap 问题

- [ ] **步骤 3：做出让 bootstrap 变绿所需的最小修复**

这个阶段常见的最终修复如下：

`apps/api/package.json`

```json
{
  "scripts": {
    "dev": "tsx watch src/main.ts",
    "build": "tsc -p tsconfig.build.json",
    "start": "node dist/main.js",
    "test": "jest --runInBand"
  }
}
```

`apps/web/package.json`

```json
{
  "scripts": {
    "dev": "next dev -p ${WEB_PORT:-3000}",
    "build": "next build",
    "start": "next start -p ${WEB_PORT:-3000}",
    "test": "vitest run"
  }
}
```

`package.json`

```json
{
  "scripts": {
    "dev": "pnpm --parallel --stream --filter @aliyun-cyber-range/api --filter @aliyun-cyber-range/web dev",
    "build": "pnpm -r build",
    "test": "pnpm -r test && node --test test/workspace-smoke.test.mjs",
    "verify:bootstrap": "pnpm test && pnpm build && docker compose config",
    "db:up": "docker compose up -d postgres",
    "db:down": "docker compose down",
    "db:logs": "docker compose logs -f postgres"
  }
}
```

- [ ] **步骤 4：重新运行全量验证并确认全部为绿色**

执行：

```bash
pnpm install
pnpm test
pnpm build
pnpm verify:bootstrap
docker compose config
pnpm --filter @aliyun-cyber-range/database test
```

预期：

- 所有测试 PASS
- `docker compose config` 执行成功

- [ ] **步骤 5：提交绿色 bootstrap 基线**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json .env.example docker-compose.yml apps/api apps/web packages/database test/workspace-smoke.test.mjs
git commit -m "feat: bootstrap platform monorepo foundation"
```
