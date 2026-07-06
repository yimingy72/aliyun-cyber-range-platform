# 综合靶场编排平台重构实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将当前平台重构为统一后台登录、四个核心模块（基础配置 / 镜像中心 / 靶场编排 / 靶场实例）的综合靶场编排平台，并让前端编排结果继续对接现有 OpenTofu 实例化链路。

**架构：** 保留后端当前可用的 `单 VPC + 多 switch + 多 ECS + OpenTofu` 编排能力，重构前端路由、后台壳、模块信息架构和拓扑编辑器表达。当前公开运行面已经统一为 `scenarios / ranges / cloud-config / image-center` 语义，实例模型也已从 `competition / team` 依赖收敛到 `name + templateId` 的当前产品模型。

**技术栈：** Next.js 15、React 19、Vitest、NestJS 11、Jest、OpenTofu、Docker Compose、阿里云编排模块

---

## 文档状态说明（2026-07-02）

这份计划的主体任务已经大部分完成，它现在更适合作为“平台级重构已完成内容”的历史执行记录。

截至 2026-07-02，后续主线已拆为两部分：

- 靶场编排器与拓扑模型实现主线：
  - [2026-06-30-scenario-orchestrator-implementation-plan.md](/Users/yym/Documents/阿里云For综合靶场竞赛平台/docs/superpowers/plans/2026-06-30-scenario-orchestrator-implementation-plan.md)
- Docker / OpenTofu / provisioning 对齐实施主线：
  - [2026-07-02-docker-opentofu-provisioning-alignment-implementation-plan.md](/Users/yym/Documents/阿里云For综合靶场竞赛平台/docs/superpowers/plans/2026-07-02-docker-opentofu-provisioning-alignment-implementation-plan.md)

当前应把这份文档理解为：

- “后台结构重构已经完成到什么程度”
- 而不是“当前实例创建链路的最终执行方案”

## 当前进度（2026-06-29 更新）

### 当前主线后续计划

- 平台级重构主线已基本完成
- 下一阶段编排器重构与编译链路增强，见：
  - `docs/superpowers/specs/2026-06-30-scenario-orchestrator-design.md`
  - `docs/superpowers/plans/2026-06-30-scenario-orchestrator-implementation-plan.md`

### 已完成

- 任务 1：移除旧角色分流与无关后台模块
- 任务 2：重构后台壳与统一导航
- 任务 3：重构统一后台登录页
- 任务 4：收敛基础配置为云配置专页
- 任务 5：新增镜像中心占位模块
- 任务 6：将“靶场模板”重构为“靶场编排”列表页
- 任务 7：重构拓扑编排页为第一阶段三节点编辑器
- 任务 8：实现节点类型感知属性面板与占位镜像字段
- 任务 9：对齐前端拓扑 JSON 与编译链路
- 任务 10：后端对齐“靶场编排”与云配置输出
- 任务 11：重构靶场实例页并收敛字段
- 任务 12：清理弃用后端模块、移除比赛/队伍公开运行面、补回归构建验证

### 当前主线成果

- 前端主路由已收敛为：`/admin`、`/admin/login`、`/admin/scenarios`、`/admin/scenarios/[scenarioId]`、`/admin/ranges`、`/admin/settings/cloud`、`/admin/image-center`
- 后端主 API 已收敛为：`/admin/scenarios`、`/admin/ranges`、`/admin/system-config`、`/admin/provision-jobs`
- `RangeInstance` 已从 `competition / team` 模型收敛为 `name + templateId` 的当前产品模型
- 前端拓扑编辑器节点语义已收敛为 `router / switch / ecs`
- 后端 `competitions / teams` 公开运行面、模块注册、repository 主线和测试 fixture 主线已移除

### 剩余事项

- 当前仍保留 `provision-jobs` 作为后台支持性 API，供实例详情与任务日志读取使用；它不再属于后台导航模块，但也尚未删除
- OpenTofu / 编排协议内部仍保留 `hosts / hostKeys / hostIds` 等字段命名，这是当前协议层的有意兼容保留，不再等同于前端产品心智
- `pnpm iac:smoke:plan` 仍受本地 `pnpm approve-builds` 策略阻塞，未能作为最终自动化回归记录进计划完成项

## 文件结构

### Web 路由与页面壳

- 修改：`apps/web/app/page.tsx`
  - 根路由改为跳转后台登录或默认后台模块，去掉旧选手入口路径心智。
- 删除：`apps/web/app/login/page.tsx`
  - 移除旧选手登录页。
- 删除：`apps/web/app/login/page.test.tsx`
  - 删除旧选手登录测试。
- 修改：`apps/web/app/admin/layout.tsx`
  - 保持后台壳入口，但承接新的导航结构。
- 修改：`apps/web/app/admin/login/page.tsx`
  - 保留后台登录路由，重构视觉与文案。
- 删除：`apps/web/app/admin/page.tsx`
  - 移除旧总览页路由。
- 删除：`apps/web/app/admin/provision-jobs/page.tsx`
  - 移除旧编排任务页路由。
- 删除：`apps/web/app/admin/settings/page.tsx`
  - 拆分旧基础配置总页，改由云配置专用路由承接。
- 删除：`apps/web/app/admin/templates/page.tsx`
  - 用新的 `scenarios` 路由替代。
- 删除：`apps/web/app/admin/templates/[templateId]/page.tsx`
  - 用新的 `scenarios/[scenarioId]` 路由替代。
- 删除：`apps/web/app/admin/range-instances/page.tsx`
  - 用新的 `ranges` 路由替代。
- 创建：`apps/web/app/admin/scenarios/page.tsx`
  - 新的靶场编排列表页路由入口。
- 创建：`apps/web/app/admin/scenarios/[scenarioId]/page.tsx`
  - 新的拓扑编排页路由入口。
- 创建：`apps/web/app/admin/ranges/page.tsx`
  - 新的靶场实例列表页路由入口。
- 创建：`apps/web/app/admin/settings/cloud/page.tsx`
  - 云配置专页路由入口。
- 创建：`apps/web/app/admin/image-center/page.tsx`
  - 镜像中心占位页路由入口。

### Web 组件与样式

- 修改：`apps/web/components/admin/admin-workspace-shell.tsx`
  - 左侧固定导航重构，只保留 4 个核心模块。
- 删除：`apps/web/components/admin/overview-screen.tsx`
  - 移除旧总览页。
- 删除：`apps/web/components/admin/overview-screen.test.tsx`
  - 删除旧总览页测试。
- 删除：`apps/web/components/admin/provision-jobs-screen.tsx`
  - 移除旧编排任务页。
- 删除：`apps/web/components/admin/provision-jobs-screen.test.tsx`
  - 删除旧编排任务页测试。
- 修改并重命名：`apps/web/components/admin/templates-screen.tsx`
  - 演进为新的靶场编排列表页组件。
- 修改并重命名：`apps/web/components/admin/templates-screen.test.tsx`
  - 改为新的靶场编排列表页测试。
- 修改：`apps/web/components/admin/template-editor/template-editor-screen.tsx`
  - 演进为靶场拓扑编排主屏。
- 修改：`apps/web/components/admin/template-editor/template-canvas.tsx`
  - 限定第一阶段为 `router / switch / ecs` 节点模型。
- 修改：`apps/web/components/admin/template-editor/template-node-palette.tsx`
  - 仅保留 3 类节点入口。
- 修改：`apps/web/components/admin/template-editor/template-property-panel.tsx`
  - 实现节点类型感知的属性面板。
- 修改：`apps/web/components/admin/template-editor/template-editor-screen.test.tsx`
  - 覆盖新的编排页结构与行为。
- 修改并重命名：`apps/web/components/admin/range-instances-screen.tsx`
  - 演进为新的靶场实例页。
- 修改并重命名：`apps/web/components/admin/range-instances-screen.test.tsx`
  - 覆盖新的实例列表字段与操作。
- 修改：`apps/web/components/admin/settings/settings-screen.tsx`
  - 收敛为仅服务云配置的页面壳，或拆为更小组件后保留路由入口用。
- 修改：`apps/web/components/admin/settings/cloud-config-panel.tsx`
  - 收敛字段为云平台、地域、可用区、AK、SK。
- 删除：`apps/web/components/admin/settings/competitions-panel.tsx`
  - 移除旧比赛配置面板。
- 删除：`apps/web/components/admin/settings/teams-panel.tsx`
  - 移除旧队伍配置面板。
- 删除：`apps/web/components/admin/settings/templates-panel.tsx`
  - 移除旧模板配置面板。
- 修改：`apps/web/components/admin/settings/settings-screen.test.tsx`
  - 改为只覆盖云配置页。
- 创建：`apps/web/components/admin/image-center-screen.tsx`
  - 镜像中心占位页和空状态。
- 创建：`apps/web/components/admin/image-center-screen.test.tsx`
  - 覆盖占位信息与未来能力说明。
- 修改：`apps/web/app/globals.css`
  - 按浅色艺术编辑器风重做后台设计 tokens 与页面层级。

### Web 类型与 API 适配层

- 修改：`apps/web/lib/admin-types.ts`
  - 引入产品层 `scenario / range / cloud-config` 语义映射。
- 修改：`apps/web/lib/admin-api.ts`
  - 新增或改造 `scenarios / ranges / cloud-config / image-center` 相关调用。
- 修改：`apps/web/lib/admin-template-defaults.ts`
  - 初始拓扑骨架改为单 `router` + 单 `switch`。
- 修改：`apps/web/lib/template-topology-skeleton.ts`
  - 对齐新的 3 类节点模型。
- 修改：`apps/web/lib/template-topology-sync.ts`
  - 保证 `topologyGraph` 与 `topologySpec` 在第一阶段新模型下同步。
- 修改：`apps/web/lib/template-topology-sync.test.ts`
  - 覆盖新的单 VPC 拓扑同步规则。
- 修改：`apps/web/lib/scenario-template-spec.ts`
  - 强化产品层靶场 JSON 结构。
- 修改：`apps/web/lib/scenario-template-compiler.ts`
  - 继续承接前端 JSON -> 编译规格。
- 修改：`apps/web/lib/topology-graph-to-scenario-template.ts`
  - 将新节点类型映射到场景 JSON。
- 修改：`apps/web/lib/template-compiler.ts`
  - 保持与后端 OpenTofu 输入契合。
- 修改：`apps/web/lib/template-compiler.test.ts`
  - 覆盖新的编排 JSON 编译行为。
- 修改：`apps/web/lib/compiled-provision-spec.ts`
  - 收紧第一阶段支持的资源模型。

### API 控制器与服务

- 修改：`apps/api/src/admin/admin-session.controller.ts`
  - 保持单后台登录语义即可，无需区分角色。
- 创建：`apps/api/src/admin/scenarios.controller.ts`
  - 当前后端主路由，承接靶场编排公开 API。
- 创建：`apps/api/src/admin/ranges.controller.ts`
  - 当前后端主路由，承接靶场实例公开 API。
- 修改：`apps/api/src/admin/system-config.controller.ts`
  - 收敛系统配置读写为云配置最小字段。
- 修改：`apps/api/src/admin/system-config.service.ts`
  - 对齐云配置字段与校验。
- 修改：`apps/api/src/admin/range-templates.service.ts`
  - 对齐新的默认骨架、摘要字段与拓扑限制。
- 修改：`apps/api/src/admin/range-instances.service.ts`
  - 对齐实例摘要和详情输出。
- 删除或弃用：`apps/api/src/admin/competitions.controller.ts`
  - 从当前主线移除比赛接口。
- 删除或弃用：`apps/api/src/admin/competitions.service.ts`
  - 从当前主线移除比赛服务。
- 删除或弃用：`apps/api/src/admin/teams.controller.ts`
  - 从当前主线移除队伍接口。
- 删除或弃用：`apps/api/src/admin/teams.service.ts`
  - 从当前主线移除队伍服务。
- 保留：`apps/api/src/admin/provision-jobs.controller.ts`
  - 当前作为实例详情和任务日志读取的支持性 API 保留，不再属于后台导航模块。
- 保留：`apps/api/src/admin/provision-jobs.service.ts`
  - 当前作为实例详情和任务日志读取的支持性服务保留。

### API DTO 与测试

- 修改：`apps/api/src/admin/dto/range-template.dto.ts`
  - 对齐新的靶场编排摘要和详情字段。
- 修改：`apps/api/src/admin/dto/range-instance.dto.ts`
  - 对齐新的实例摘要和详情字段。
- 删除或弃用：`apps/api/src/admin/dto/competition.dto.ts`
  - 移除比赛 DTO。
- 删除或弃用：`apps/api/src/admin/dto/team.dto.ts`
  - 移除队伍 DTO。
- 修改：`apps/api/test/admin-system-config.e2e-spec.ts`
  - 改为验证云配置最小字段。
- 修改：`apps/api/test/admin-resources.e2e-spec.ts`
  - 对齐新的后台资源输出。
- 修改：`apps/api/test/admin-resource-validation.e2e-spec.ts`
  - 校验新的拓扑约束与云配置约束。
- 修改：`apps/api/test/open-tofu-range-provisioner.e2e-spec.ts`
  - 确认新前端编排 JSON 仍能驱动实例创建。
- 修改：`apps/api/test/alibaba-cloud-opentofu-renderer.e2e-spec.ts`
  - 覆盖 `router / switch / ecs` 第一阶段模型。

## 任务 1：移除旧角色分流与无关后台模块（已完成）

**文件：**
- 修改：`apps/web/app/page.tsx`
- 删除：`apps/web/app/login/page.tsx`
- 删除：`apps/web/app/login/page.test.tsx`
- 删除：`apps/web/app/admin/page.tsx`
- 删除：`apps/web/app/admin/provision-jobs/page.tsx`
- 删除：`apps/web/components/admin/overview-screen.tsx`
- 删除：`apps/web/components/admin/overview-screen.test.tsx`
- 删除：`apps/web/components/admin/provision-jobs-screen.tsx`
- 删除：`apps/web/components/admin/provision-jobs-screen.test.tsx`

- [ ] **步骤 1：编写失败的路由测试**

```tsx
import { redirect } from 'next/navigation';

it('redirects the root route to /admin/login', () => {
  HomePage();
  expect(redirect).toHaveBeenCalledWith('/admin/login');
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @aliyun-cyber-range/web test -- app/page.test.tsx`
预期：FAIL，根路由仍跳到旧的 `/login`

- [ ] **步骤 3：修改根路由与删除旧选手入口页面**

```tsx
export default function HomePage() {
  redirect('/admin/login');
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm --filter @aliyun-cyber-range/web test -- app/page.test.tsx`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add apps/web/app/page.tsx apps/web/app/page.test.tsx apps/web/app/login/page.tsx apps/web/app/login/page.test.tsx apps/web/app/admin/page.tsx apps/web/app/admin/provision-jobs/page.tsx apps/web/components/admin/overview-screen.tsx apps/web/components/admin/overview-screen.test.tsx apps/web/components/admin/provision-jobs-screen.tsx apps/web/components/admin/provision-jobs-screen.test.tsx
git commit -m "refactor: remove old entrypoints and deprecated admin modules"
```

## 任务 2：重构后台壳与统一导航（已完成）

**文件：**
- 修改：`apps/web/components/admin/admin-workspace-shell.tsx`
- 修改：`apps/web/app/admin/layout.tsx`
- 修改：`apps/web/app/globals.css`
- 测试：`apps/web/components/admin/admin-workspace-shell.test.tsx`

- [ ] **步骤 1：编写失败的导航测试**

```tsx
it('renders only cloud config, image center, scenarios and ranges in the sidebar', () => {
  render(<AdminWorkspaceShell><div>content</div></AdminWorkspaceShell>);

  expect(screen.getByText('基础配置')).toBeTruthy();
  expect(screen.getByText('镜像中心')).toBeTruthy();
  expect(screen.getByText('靶场编排')).toBeTruthy();
  expect(screen.getByText('靶场实例')).toBeTruthy();
  expect(screen.queryByText('靶场总览')).toBeNull();
  expect(screen.queryByText('编排任务')).toBeNull();
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @aliyun-cyber-range/web test -- components/admin/admin-workspace-shell.test.tsx`
预期：FAIL，当前侧栏仍显示旧模块

- [ ] **步骤 3：重构导航结构与浅色艺术编辑器壳层样式**

```tsx
const navigationItems = [
  { href: '/admin/scenarios', label: '靶场编排' },
  { href: '/admin/ranges', label: '靶场实例' },
  { href: '/admin/settings/cloud', label: '基础配置' },
  { href: '/admin/image-center', label: '镜像中心' },
];
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm --filter @aliyun-cyber-range/web test -- components/admin/admin-workspace-shell.test.tsx`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add apps/web/components/admin/admin-workspace-shell.tsx apps/web/app/admin/layout.tsx apps/web/app/globals.css apps/web/components/admin/admin-workspace-shell.test.tsx
git commit -m "refactor: rebuild admin shell navigation"
```

## 任务 3：重构统一后台登录页（已完成）

**文件：**
- 修改：`apps/web/app/admin/login/page.tsx`
- 修改：`apps/web/app/admin/login/page.test.tsx`
- 修改：`apps/web/components/auth/admin-login-screen.tsx`
- 修改：`apps/web/app/globals.css`

- [ ] **步骤 1：编写失败的登录页测试**

```tsx
it('renders a single backstage login experience without player entry copy', async () => {
  render(<AdminLoginPage />);

  expect(screen.getByRole('heading', { name: '管理员登录' })).toBeTruthy();
  expect(screen.queryByText('选手入口')).toBeNull();
  expect(screen.getByDisplayValue('admin')).toBeTruthy();
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @aliyun-cyber-range/web test -- app/admin/login/page.test.tsx`
预期：FAIL，当前仍保留旧说明或旧入口

- [ ] **步骤 3：实现新的单后台登录页视觉与文案**

```tsx
<main className="admin-login-shell">
  <section className="admin-login-brand">...</section>
  <section className="admin-login-panel">...</section>
</main>
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm --filter @aliyun-cyber-range/web test -- app/admin/login/page.test.tsx`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add apps/web/app/admin/login/page.tsx apps/web/app/admin/login/page.test.tsx apps/web/components/auth/admin-login-screen.tsx apps/web/app/globals.css
git commit -m "feat: redesign unified admin login"
```

## 任务 4：收敛基础配置为云配置专页（已完成）

**文件：**
- 创建：`apps/web/app/admin/settings/cloud/page.tsx`
- 修改：`apps/web/components/admin/settings/settings-screen.tsx`
- 修改：`apps/web/components/admin/settings/cloud-config-panel.tsx`
- 删除：`apps/web/components/admin/settings/competitions-panel.tsx`
- 删除：`apps/web/components/admin/settings/teams-panel.tsx`
- 删除：`apps/web/components/admin/settings/templates-panel.tsx`
- 修改：`apps/web/components/admin/settings/settings-screen.test.tsx`
- 修改：`apps/web/lib/admin-types.ts`
- 修改：`apps/web/lib/admin-api.ts`
- 修改：`apps/api/src/admin/system-config.controller.ts`
- 修改：`apps/api/src/admin/system-config.service.ts`
- 修改：`apps/api/test/admin-system-config.e2e-spec.ts`

- [ ] **步骤 1：编写失败的云配置页面测试**

```tsx
it('shows only provider, region, zone, access key id and access key secret fields', async () => {
  render(<SettingsScreen />);

  expect(screen.getByLabelText('云平台')).toBeTruthy();
  expect(screen.getByLabelText('默认地域')).toBeTruthy();
  expect(screen.getByLabelText('默认可用区')).toBeTruthy();
  expect(screen.getByLabelText('AccessKey ID')).toBeTruthy();
  expect(screen.getByLabelText('AccessKey Secret')).toBeTruthy();
  expect(screen.queryByText('比赛配置')).toBeNull();
  expect(screen.queryByText('队伍配置')).toBeNull();
});
```

- [ ] **步骤 2：运行前端测试验证失败**

运行：`pnpm --filter @aliyun-cyber-range/web test -- components/admin/settings/settings-screen.test.tsx`
预期：FAIL，当前仍渲染旧面板

- [ ] **步骤 3：编写失败的 API 测试**

```ts
it('persists only the cloud configuration fields used by the new admin UI', async () => {
  const response = await request(app.getHttpServer())
    .patch('/admin/system-config')
    .set('Authorization', 'Bearer dev-admin-token')
    .send({
      provider: 'alibaba_cloud',
      defaultRegion: 'cn-hangzhou',
      defaultZoneId: 'cn-hangzhou-h',
      accessKeyId: 'LTAI***',
      accessKeySecret: '***',
    });

  expect(response.status).toBe(200);
  expect(response.body).toEqual(expect.objectContaining({ provider: 'alibaba_cloud' }));
});
```

- [ ] **步骤 4：运行 API 测试验证失败**

运行：`pnpm --filter @aliyun-cyber-range/api test -- test/admin-system-config.e2e-spec.ts`
预期：FAIL，返回结构仍包含旧字段

- [ ] **步骤 5：实现前后端云配置收敛**

```ts
export type AdminCloudConfig = {
  provider: 'alibaba_cloud' | 'other';
  defaultRegion: string;
  defaultZoneId: string;
  accessKeyId: string;
  accessKeySecret: string;
};
```

- [ ] **步骤 6：运行测试验证通过**

运行：`pnpm --filter @aliyun-cyber-range/web test -- components/admin/settings/settings-screen.test.tsx`
预期：PASS

运行：`pnpm --filter @aliyun-cyber-range/api test -- test/admin-system-config.e2e-spec.ts`
预期：PASS

- [ ] **步骤 7：Commit**

```bash
git add apps/web/app/admin/settings/cloud/page.tsx apps/web/components/admin/settings/settings-screen.tsx apps/web/components/admin/settings/cloud-config-panel.tsx apps/web/components/admin/settings/settings-screen.test.tsx apps/web/lib/admin-types.ts apps/web/lib/admin-api.ts apps/api/src/admin/system-config.controller.ts apps/api/src/admin/system-config.service.ts apps/api/test/admin-system-config.e2e-spec.ts apps/web/components/admin/settings/competitions-panel.tsx apps/web/components/admin/settings/teams-panel.tsx apps/web/components/admin/settings/templates-panel.tsx
git commit -m "refactor: simplify admin settings to cloud config only"
```

## 任务 5：新增镜像中心占位模块（已完成）

**文件：**
- 创建：`apps/web/app/admin/image-center/page.tsx`
- 创建：`apps/web/components/admin/image-center-screen.tsx`
- 创建：`apps/web/components/admin/image-center-screen.test.tsx`
- 修改：`apps/web/app/globals.css`

- [ ] **步骤 1：编写失败的镜像中心测试**

```tsx
it('renders the image center placeholder with future capability guidance', () => {
  render(<ImageCenterScreen />);

  expect(screen.getByRole('heading', { name: '镜像中心' })).toBeTruthy();
  expect(screen.getByText('当前阶段暂未接入真实云镜像管理能力。')).toBeTruthy();
  expect(screen.getByText('查看镜像')).toBeTruthy();
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @aliyun-cyber-range/web test -- components/admin/image-center-screen.test.tsx`
预期：FAIL，组件尚不存在

- [ ] **步骤 3：实现镜像中心占位页与空状态**

```tsx
<section className="admin-empty-state">
  <strong>当前阶段暂未接入真实云镜像管理能力。</strong>
  <p>后续这里将用于查看镜像、删除镜像、导出镜像和从镜像创建单实例。</p>
</section>
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm --filter @aliyun-cyber-range/web test -- components/admin/image-center-screen.test.tsx`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add apps/web/app/admin/image-center/page.tsx apps/web/components/admin/image-center-screen.tsx apps/web/components/admin/image-center-screen.test.tsx apps/web/app/globals.css
git commit -m "feat: add image center placeholder module"
```

## 任务 6：将“靶场模板”重构为“靶场编排”列表页（已完成）

**文件：**
- 创建：`apps/web/app/admin/scenarios/page.tsx`
- 修改：`apps/web/components/admin/templates-screen.tsx`
- 修改：`apps/web/components/admin/templates-screen.test.tsx`
- 修改：`apps/web/lib/admin-types.ts`
- 修改：`apps/web/lib/admin-api.ts`
- 修改：`apps/web/app/globals.css`

- [ ] **步骤 1：编写失败的列表页测试**

```tsx
it('renders the scenario workbench as the default admin home surface', async () => {
  render(<TemplatesScreen apiBaseUrl="http://localhost:3001" />);

  expect(await screen.findByRole('heading', { name: '靶场编排' })).toBeTruthy();
  expect(screen.getByText('靶场名')).toBeTruthy();
  expect(screen.getByText('靶场描述')).toBeTruthy();
  expect(screen.getByText('拓扑概览')).toBeTruthy();
  expect(screen.getByText('状态')).toBeTruthy();
  expect(screen.getByText('操作')).toBeTruthy();
  expect(screen.queryByText('模板')).toBeNull();
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @aliyun-cyber-range/web test -- components/admin/templates-screen.test.tsx`
预期：FAIL，当前文案和布局仍是旧模板工作台

- [ ] **步骤 3：重构列表页结构、文案与操作语义**

```tsx
const primaryActionLabel = '编排';
const rowColumns = ['靶场名', '靶场描述', '拓扑概览', '状态', '操作'];
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm --filter @aliyun-cyber-range/web test -- components/admin/templates-screen.test.tsx`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add apps/web/app/admin/scenarios/page.tsx apps/web/components/admin/templates-screen.tsx apps/web/components/admin/templates-screen.test.tsx apps/web/lib/admin-types.ts apps/web/lib/admin-api.ts apps/web/app/globals.css
git commit -m "refactor: convert templates workbench into scenario workbench"
```

## 任务 7：重构拓扑编排页为第一阶段三节点编辑器（已完成）

**文件：**
- 创建：`apps/web/app/admin/scenarios/[scenarioId]/page.tsx`
- 修改：`apps/web/components/admin/template-editor/template-editor-screen.tsx`
- 修改：`apps/web/components/admin/template-editor/template-editor-screen.test.tsx`
- 修改：`apps/web/components/admin/template-editor/template-node-palette.tsx`
- 修改：`apps/web/components/admin/template-editor/template-canvas.tsx`
- 修改：`apps/web/components/admin/template-editor/template-property-panel.tsx`
- 修改：`apps/web/lib/admin-template-defaults.ts`
- 修改：`apps/web/lib/template-topology-skeleton.ts`

- [ ] **步骤 1：编写失败的编排页测试**

```tsx
it('supports only router, switch and ecs nodes in the phase-one topology editor', async () => {
  render(<TemplateEditorScreen />);

  expect(await screen.findByText('Router')).toBeTruthy();
  expect(screen.getByText('Switch')).toBeTruthy();
  expect(screen.getByText('ECS')).toBeTruthy();
  expect(screen.queryByText('NAT 网关')).toBeNull();
  expect(screen.queryByText('EIP')).toBeNull();
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @aliyun-cyber-range/web test -- components/admin/template-editor/template-editor-screen.test.tsx`
预期：FAIL，当前资源栏仍包含历史节点类型

- [ ] **步骤 3：重构资源栏、画布与默认骨架**

```ts
const phaseOneNodeTypes = ['router', 'switch', 'ecs'] as const;
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm --filter @aliyun-cyber-range/web test -- components/admin/template-editor/template-editor-screen.test.tsx`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add apps/web/app/admin/scenarios/[scenarioId]/page.tsx apps/web/components/admin/template-editor/template-editor-screen.tsx apps/web/components/admin/template-editor/template-editor-screen.test.tsx apps/web/components/admin/template-editor/template-node-palette.tsx apps/web/components/admin/template-editor/template-canvas.tsx apps/web/components/admin/template-editor/template-property-panel.tsx apps/web/lib/admin-template-defaults.ts apps/web/lib/template-topology-skeleton.ts
git commit -m "feat: rebuild topology editor for phase-one scenario model"
```

## 任务 8：实现节点类型感知属性面板与占位镜像字段（已完成）

**文件：**
- 修改：`apps/web/components/admin/template-editor/template-property-panel.tsx`
- 修改：`apps/web/components/admin/template-editor/template-editor-screen.test.tsx`
- 修改：`apps/web/lib/scenario-template-spec.ts`
- 修改：`apps/web/lib/admin-types.ts`

- [ ] **步骤 1：编写失败的属性面板测试**

```tsx
it('shows placeholder image fields only on ecs nodes', async () => {
  render(<TemplateEditorScreen />);

  userEvent.click(await screen.findByRole('button', { name: /ecs/i }));
  expect(screen.getByLabelText('镜像名')).toBeTruthy();
  expect(screen.getByLabelText('镜像 ID')).toBeTruthy();
  expect(screen.queryByLabelText('CIDR')).toBeNull();
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @aliyun-cyber-range/web test -- components/admin/template-editor/template-editor-screen.test.tsx`
预期：FAIL，当前字段集未按节点类型分离

- [ ] **步骤 3：实现三类节点专属属性结构**

```ts
type ScenarioEcsNodeConfig = {
  instanceName: string;
  hostname: string;
  imageName: string;
  imageId: string;
  privateIp: string;
  securityGroupRules: SecurityGroupRule[];
};
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm --filter @aliyun-cyber-range/web test -- components/admin/template-editor/template-editor-screen.test.tsx`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add apps/web/components/admin/template-editor/template-property-panel.tsx apps/web/components/admin/template-editor/template-editor-screen.test.tsx apps/web/lib/scenario-template-spec.ts apps/web/lib/admin-types.ts
git commit -m "feat: add phase-one scenario node configuration panels"
```

## 任务 9：对齐前端拓扑 JSON 与编译链路（已完成）

**文件：**
- 修改：`apps/web/lib/template-topology-sync.ts`
- 修改：`apps/web/lib/template-topology-sync.test.ts`
- 修改：`apps/web/lib/topology-graph-to-scenario-template.ts`
- 修改：`apps/web/lib/scenario-template-compiler.ts`
- 修改：`apps/web/lib/template-compiler.ts`
- 修改：`apps/web/lib/template-compiler.test.ts`
- 修改：`apps/web/lib/compiled-provision-spec.ts`

- [ ] **步骤 1：编写失败的同步测试**

```ts
it('compiles a single-vpc topology graph into the provision-ready scenario spec', () => {
  const result = syncTopologyGraphToScenarioTemplate(phaseOneGraph);

  expect(result.topologySpec.router).toEqual(expect.objectContaining({ type: 'router' }));
  expect(result.topologySpec.switches).toHaveLength(1);
  expect(result.topologySpec.hosts).toHaveLength(1);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @aliyun-cyber-range/web test -- lib/template-topology-sync.test.ts lib/template-compiler.test.ts`
预期：FAIL，当前模型仍混有历史节点结构

- [ ] **步骤 3：实现新的拓扑 JSON -> 编译规格转换**

```ts
export function compileScenarioTemplate(input: ScenarioTemplateSpec): CompiledProvisionSpec {
  return {
    vpc: input.topologySpec.router,
    switches: input.topologySpec.switches,
    ecsInstances: input.topologySpec.hosts,
  };
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm --filter @aliyun-cyber-range/web test -- lib/template-topology-sync.test.ts lib/template-compiler.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add apps/web/lib/template-topology-sync.ts apps/web/lib/template-topology-sync.test.ts apps/web/lib/topology-graph-to-scenario-template.ts apps/web/lib/scenario-template-compiler.ts apps/web/lib/template-compiler.ts apps/web/lib/template-compiler.test.ts apps/web/lib/compiled-provision-spec.ts
git commit -m "feat: align scenario topology json with provision compiler"
```

## 任务 10：后端对齐“靶场编排”与云配置输出（已完成）

**文件：**
- 修改：`apps/api/src/admin/range-templates.controller.ts`
- 修改：`apps/api/src/admin/range-templates.service.ts`
- 修改：`apps/api/src/admin/dto/range-template.dto.ts`
- 修改：`apps/api/src/admin/range-instances.controller.ts`
- 修改：`apps/api/src/admin/range-instances.service.ts`
- 修改：`apps/api/src/admin/dto/range-instance.dto.ts`
- 修改：`apps/api/test/admin-resources.e2e-spec.ts`
- 修改：`apps/api/test/admin-resource-validation.e2e-spec.ts`

- [ ] **步骤 1：编写失败的资源摘要测试**

```ts
it('returns scenario summaries that match the new admin workbench fields', async () => {
  const response = await request(app.getHttpServer())
    .get('/admin/range-templates')
    .set('Authorization', 'Bearer dev-admin-token');

  expect(response.status).toBe(200);
  expect(response.body.rangeTemplates[0]).toEqual(
    expect.objectContaining({ name: expect.any(String), description: expect.anything() }),
  );
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @aliyun-cyber-range/api test -- test/admin-resources.e2e-spec.ts test/admin-resource-validation.e2e-spec.ts`
预期：FAIL，输出结构仍以旧页面心智为主

- [ ] **步骤 3：调整摘要输出与拓扑校验约束**

```ts
if (routerCount !== 1) {
  throw new BadRequestException('phase-one topology requires exactly one router');
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm --filter @aliyun-cyber-range/api test -- test/admin-resources.e2e-spec.ts test/admin-resource-validation.e2e-spec.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add apps/api/src/admin/range-templates.controller.ts apps/api/src/admin/range-templates.service.ts apps/api/src/admin/dto/range-template.dto.ts apps/api/src/admin/range-instances.controller.ts apps/api/src/admin/range-instances.service.ts apps/api/src/admin/dto/range-instance.dto.ts apps/api/test/admin-resources.e2e-spec.ts apps/api/test/admin-resource-validation.e2e-spec.ts
git commit -m "refactor: align admin scenario and range resource outputs"
```

## 任务 11：重构靶场实例页并收敛字段（已完成）

**文件：**
- 创建：`apps/web/app/admin/ranges/page.tsx`
- 修改：`apps/web/components/admin/range-instances-screen.tsx`
- 修改：`apps/web/components/admin/range-instances-screen.test.tsx`
- 修改：`apps/web/lib/admin-api.ts`
- 修改：`apps/web/lib/admin-types.ts`

- [ ] **步骤 1：编写失败的实例页测试**

```tsx
it('shows name, scenario name, status, created time and actions on the ranges page', async () => {
  render(<RangeInstancesScreen apiBaseUrl="http://localhost:3001" />);

  expect(await screen.findByText('实例名')).toBeTruthy();
  expect(screen.getByText('靶场名')).toBeTruthy();
  expect(screen.getByText('状态')).toBeTruthy();
  expect(screen.getByText('创建时间')).toBeTruthy();
  expect(screen.getByText('操作')).toBeTruthy();
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @aliyun-cyber-range/web test -- components/admin/range-instances-screen.test.tsx`
预期：FAIL，当前字段和交互仍过重

- [ ] **步骤 3：重构实例列表页与详情入口**

```tsx
const visibleColumns = ['实例名', '靶场名', '状态', '创建时间', '操作'];
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm --filter @aliyun-cyber-range/web test -- components/admin/range-instances-screen.test.tsx`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add apps/web/app/admin/ranges/page.tsx apps/web/components/admin/range-instances-screen.tsx apps/web/components/admin/range-instances-screen.test.tsx apps/web/lib/admin-api.ts apps/web/lib/admin-types.ts
git commit -m "refactor: simplify ranges page for phase-one lifecycle management"
```

## 任务 12：端到端校验并清理弃用后端模块（已基本完成）

**文件：**
- 删除或弃用：`apps/api/src/admin/competitions.controller.ts`
- 删除或弃用：`apps/api/src/admin/competitions.service.ts`
- 删除或弃用：`apps/api/src/admin/teams.controller.ts`
- 删除或弃用：`apps/api/src/admin/teams.service.ts`
- 保留：`apps/api/src/admin/provision-jobs.controller.ts`
- 保留：`apps/api/src/admin/provision-jobs.service.ts`
- 修改：`apps/api/src/app.module.ts`
- 修改：`apps/web/app/globals.css`

- [ ] **步骤 1：编写失败的构建/路由冒烟检查记录**

```bash
pnpm --filter @aliyun-cyber-range/web build
pnpm --filter @aliyun-cyber-range/api build
```

预期：当前阶段至少一项会因旧模块引用而失败

- [ ] **步骤 2：移除或断开已弃用模块的注入与路由注册**

```ts
// app.module.ts
controllers: [AdminSessionController, ScenariosController, RangesController, ProvisionJobsController, SystemConfigController],
```

- [ ] **步骤 3：运行前端、后端与编排回归**

运行：`pnpm --filter @aliyun-cyber-range/web test`
预期：PASS

运行：`pnpm --filter @aliyun-cyber-range/api test`
预期：PASS

运行：`pnpm build`
预期：PASS

运行：`pnpm iac:smoke:plan`
当前结果：受本地 `pnpm approve-builds` 策略阻塞，未形成可复用自动化回归记录

- [ ] **步骤 4：Commit**

```bash
git add apps/api/src/admin/competitions.controller.ts apps/api/src/admin/competitions.service.ts apps/api/src/admin/teams.controller.ts apps/api/src/admin/teams.service.ts apps/api/src/admin/provision-jobs.controller.ts apps/api/src/admin/provision-jobs.service.ts apps/api/src/app.module.ts apps/web/app/globals.css
git commit -m "refactor: prune deprecated admin modules and verify platform restructure"
```

## 自检

### 规格覆盖度

本计划已覆盖以下已确认需求：

- 统一后台登录，去掉选手入口
- 后台只保留 4 个核心模块
- 基础配置只保留云配置
- 镜像中心保留占位模块
- `靶场模板` 重构为 `靶场编排`
- 拓扑编辑器第一阶段只支持 `router / switch / ecs`
- `ecs` 使用镜像占位信息
- 靶场实例页字段收敛为：实例名、靶场名、状态、创建时间、操作
- 前端编排 JSON 继续对接 OpenTofu 编译与实例创建
- 清理旧总览、旧任务、旧比赛/队伍模块

### 占位符扫描

本计划未使用：

- `TODO`
- `待定`
- `补充细节`
- “后续实现”式空占位步骤

镜像中心“占位模块”在这里不是占位步骤，而是明确的第一阶段产物。

### 类型一致性

本计划统一使用以下产品层术语：

- `靶场编排` -> `scenario`
- `靶场实例` -> `range`
- `云配置` -> `cloud config`
- 第一阶段节点类型：`router / switch / ecs`

后端内部仍存在 `range-template / range-instance` 基础模型，但公开 API 与前端产品语义已收敛到 `scenarios / ranges`。

## 执行交接

计划已完成并保存到 `docs/superpowers/plans/2026-06-29-platform-restructure-implementation-plan.md`。两种执行方式：

**1. 子代理驱动（推荐）** - 每个任务调度一个新的子代理，任务间进行审查，快速迭代

**2. 内联执行** - 在当前会话中使用 `executing-plans` 执行任务，批量执行并设有检查点

选哪种方式？
