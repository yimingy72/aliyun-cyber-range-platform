# Platform Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first working slice of the platform: a monorepo workspace with a runnable NestJS API health endpoint, a minimal Next.js operator homepage, and a validated PostgreSQL/Prisma bootstrap package.

**Architecture:** Keep the repo as a modular monorepo with `apps/` for runtime surfaces and `packages/` for shared or infrastructure-adjacent code. Treat the bootstrap as a thin vertical slice: validate workspace wiring first, then add API behavior, then web behavior, then database/bootstrap configuration validation.

**Tech Stack:** pnpm workspace, TypeScript, NestJS, Next.js App Router, Vitest, Jest, Docker Compose, PostgreSQL, Prisma

---

## Scope Check

The full spec covers multiple independent subsystems: admin product, domain model, orchestration engine, IaC runner, image pipeline, and visual system. This plan intentionally covers only the first executable sub-project:

- monorepo bootstrap
- API health endpoint
- web bootstrap page
- PostgreSQL + Prisma bootstrap wiring

Later plans should cover:

- competition/team/template CRUD
- range instance and provision jobs
- OpenTofu runner
- orchestrator state machine

## File Structure

### Root workspace files

- Create: `package.json`
  Responsibility: workspace scripts for dev, build, test, and database lifecycle
- Create: `pnpm-workspace.yaml`
  Responsibility: declare `apps/*` and `packages/*` package roots
- Create: `tsconfig.base.json`
  Responsibility: shared TypeScript compiler defaults
- Create: `.env.example`
  Responsibility: document local development environment variables
- Create: `docker-compose.yml`
  Responsibility: local PostgreSQL bootstrap
- Create: `test/workspace-smoke.test.mjs`
  Responsibility: smoke-check root workspace contract

### API files

- Create: `apps/api/package.json`
  Responsibility: API dependencies and scripts
- Create: `apps/api/tsconfig.json`
  Responsibility: API TypeScript config
- Create: `apps/api/tsconfig.build.json`
  Responsibility: API build-only TypeScript config
- Create: `apps/api/jest.config.js`
  Responsibility: API test runner config
- Create: `apps/api/src/app.controller.ts`
  Responsibility: HTTP endpoints for bootstrap phase
- Create: `apps/api/src/app.module.ts`
  Responsibility: bootstrap module wiring
- Create: `apps/api/src/main.ts`
  Responsibility: Nest application startup
- Create: `apps/api/test/health.e2e-spec.ts`
  Responsibility: failing-then-passing health endpoint contract

### Web files

- Create: `apps/web/package.json`
  Responsibility: web dependencies and scripts
- Create: `apps/web/tsconfig.json`
  Responsibility: Next.js TypeScript config
- Create: `apps/web/next-env.d.ts`
  Responsibility: Next.js generated type references
- Create: `apps/web/vitest.config.ts`
  Responsibility: jsdom test runner config
- Create: `apps/web/app/layout.tsx`
  Responsibility: root document shell and metadata
- Create: `apps/web/app/page.tsx`
  Responsibility: operator-facing bootstrap homepage
- Create: `apps/web/app/page.test.tsx`
  Responsibility: failing-then-passing homepage behavior test
- Create: `apps/web/app/globals.css`
  Responsibility: minimal visual system for bootstrap page

### Database package files

- Create: `packages/database/package.json`
  Responsibility: Prisma package scripts and dependencies
- Create: `packages/database/prisma/schema.prisma`
  Responsibility: bootstrap datasource and client generator
- Create: `packages/database/test/schema-config.test.mjs`
  Responsibility: validate Prisma bootstrap contract and env agreement

## Task 1: Establish the root workspace contract

**Files:**
- Create: `test/workspace-smoke.test.mjs`
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`

- [ ] **Step 1: Write the failing workspace smoke test**

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

- [ ] **Step 2: Run the smoke test to verify it fails**

Run:

```bash
node --test test/workspace-smoke.test.mjs
```

Expected:

- FAIL because `package.json` and `pnpm-workspace.yaml` do not exist yet

- [ ] **Step 3: Write the minimal root workspace files**

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

- [ ] **Step 4: Re-run the workspace smoke test**

Run:

```bash
node --test test/workspace-smoke.test.mjs
```

Expected:

- PASS

- [ ] **Step 5: Commit the root workspace contract**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json test/workspace-smoke.test.mjs
git commit -m "chore: establish workspace bootstrap"
```

## Task 2: Add a passing API health endpoint

**Files:**
- Create: `apps/api/package.json`
- Create: `apps/api/tsconfig.json`
- Create: `apps/api/tsconfig.build.json`
- Create: `apps/api/jest.config.js`
- Create: `apps/api/test/health.e2e-spec.ts`
- Create: `apps/api/src/app.controller.ts`
- Create: `apps/api/src/app.module.ts`
- Create: `apps/api/src/main.ts`

- [ ] **Step 1: Write the failing API health endpoint test**

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

- [ ] **Step 2: Run the API test to verify it fails**

Run:

```bash
pnpm install
pnpm --filter @aliyun-cyber-range/api test -- health.e2e-spec.ts
```

Expected:

- FAIL with `404 Not Found` or module bootstrap failure until the API files exist

- [ ] **Step 3: Write the minimal API implementation**

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

- [ ] **Step 4: Run the API test to verify it passes**

Run:

```bash
pnpm --filter @aliyun-cyber-range/api test -- health.e2e-spec.ts
```

Expected:

- PASS

- [ ] **Step 5: Commit the API bootstrap slice**

```bash
git add apps/api
git commit -m "feat: add api health endpoint bootstrap"
```

## Task 3: Add a passing operator homepage

**Files:**
- Create: `apps/web/package.json`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/next-env.d.ts`
- Create: `apps/web/vitest.config.ts`
- Create: `apps/web/app/page.test.tsx`
- Create: `apps/web/app/layout.tsx`
- Create: `apps/web/app/page.tsx`
- Create: `apps/web/app/globals.css`

- [ ] **Step 1: Write the failing web page test**

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

- [ ] **Step 2: Run the web test to verify it fails**

Run:

```bash
pnpm --filter @aliyun-cyber-range/web test -- page.test.tsx
```

Expected:

- FAIL because the page does not yet render the expected heading

- [ ] **Step 3: Write the minimal web implementation**

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

- [ ] **Step 4: Run the web test to verify it passes**

Run:

```bash
pnpm --filter @aliyun-cyber-range/web test -- page.test.tsx
```

Expected:

- PASS

- [ ] **Step 5: Commit the web bootstrap slice**

```bash
git add apps/web
git commit -m "feat: add operator bootstrap homepage"
```

## Task 4: Validate PostgreSQL and Prisma bootstrap wiring

**Files:**
- Create: `.env.example`
- Create: `docker-compose.yml`
- Create: `packages/database/package.json`
- Create: `packages/database/prisma/schema.prisma`
- Create: `packages/database/test/schema-config.test.mjs`

- [ ] **Step 1: Write the failing database bootstrap test**

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

- [ ] **Step 2: Run the database bootstrap test to verify it fails**

Run:

```bash
node --test packages/database/test/schema-config.test.mjs
```

Expected:

- FAIL because the env file, schema, or package contract is missing

- [ ] **Step 3: Write the minimal database bootstrap files**

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

- [ ] **Step 4: Run the database bootstrap verification**

Run:

```bash
pnpm --filter @aliyun-cyber-range/database test
docker compose config
```

Expected:

- database bootstrap test PASS
- `docker compose config` exits successfully and renders a valid config

- [ ] **Step 5: Commit the database bootstrap slice**

```bash
git add .env.example docker-compose.yml packages/database
git commit -m "chore: add postgres and prisma bootstrap wiring"
```

## Task 5: Validate the whole bootstrap slice together

**Files:**
- Modify: `package.json`
- Modify: `apps/api/package.json`
- Modify: `apps/web/package.json`
- Modify: `packages/database/package.json`

- [ ] **Step 1: Write the failing full-bootstrap verification checklist**

Create a local checklist in your working notes and treat these as red-state verification commands:

```text
1. pnpm install
2. pnpm test
3. pnpm build
4. pnpm verify:bootstrap
5. docker compose config
6. pnpm --filter @aliyun-cyber-range/database test
```

- [ ] **Step 2: Run the full verification to identify failures**

Run:

```bash
pnpm install
pnpm test
pnpm build
pnpm verify:bootstrap
docker compose config
pnpm --filter @aliyun-cyber-range/database test
```

Expected:

- Any remaining failures should be concrete dependency or config mismatches, not vague bootstrap problems

- [ ] **Step 3: Make the minimal fixes needed to get a clean bootstrap**

Typical final fixes at this stage:

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

- [ ] **Step 4: Re-run the full verification and confirm it is green**

Run:

```bash
pnpm install
pnpm test
pnpm build
pnpm verify:bootstrap
docker compose config
pnpm --filter @aliyun-cyber-range/database test
```

Expected:

- all tests PASS
- `docker compose config` succeeds

- [ ] **Step 5: Commit the green bootstrap baseline**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json .env.example docker-compose.yml apps/api apps/web packages/database test/workspace-smoke.test.mjs
git commit -m "feat: bootstrap platform monorepo foundation"
```
