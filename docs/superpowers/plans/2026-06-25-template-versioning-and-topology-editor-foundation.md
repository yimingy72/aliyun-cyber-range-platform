# 模板版本化与拓扑编辑器底座 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把综合靶场模板中心升级为“模板身份 + 模板版本 + 发布编译产物”的可扩展底座，并落下第一版可视化拓扑编辑器后端/前端骨架。

**Architecture:** 保持现有模块化单体架构，在 API 层引入 `RangeTemplateVersion`、草稿/已发布指针和发布流程，在 Web 层引入独立的模板编辑工作区。模板编辑器只操作草稿版本，实例创建和编排执行只引用已发布版本。拓扑编辑状态使用平台内部 `TopologyGraph JSON`，编排执行继续兼容当前 `topologySpec`，后续再逐步切到统一编译器。

**Tech Stack:** NestJS 11、Next.js 15 App Router、React 19、Prisma/PostgreSQL、Vitest/Jest、OpenTofu Runner、现有 Admin REST API

## 当前进度快照（2026-06-25）

- 已完成 Task 1：模板版本化后端模型、内存仓储、数据库仓储、实例/worker 读取已发布版本的主链路已落地。
- 已完成 Task 2：模板发布流程与“实例只能引用已发布模板”的约束已落地。
- 已完成 Task 3：`topologyGraph` / `compiledSpec` 通用 JSON 边界、草稿/顶层字段一致性、负例测试、Prisma migration 与存量模板回填已落地。
- 已完成 Task 4：模板中心已显示草稿/已发布状态，并可进入编辑器、发布模板。
- 已完成 Task 5 且已超过原骨架目标：模板编辑器不仅已可渲染，还支持节点新增、按节点类型编辑属性、保存草稿、发布模板。
- 已完成 Task 6：`TopologyGraph -> compiledSpec` 最小编译闭环已落地，保存草稿会稳定提交编译产物。
- 已完成 Task 7 首轮闭环：企业靶场默认骨架生成器、节点到 `topologySpec` 的同步器、发布前 `compiledSpec/topologySpec` 一致性校验已落地。
- 已完成 Task 8 首轮收口：编排 worker 已优先消费已发布版本中的 `compiledSpec.topologySpec`，旧 `topologySpec` 仅作为回退路径。
- 已完成 Task 9 首轮收口：新增企业靶场 `provision plan` 层，`dry-run` 与 `OpenTofu` provisioner 已统一通过标准计划消费模板拓扑。
- 已完成 Task 10 首轮收口：后端 `provision plan` 已可直接从 `compiledSpec.resources[]` 重建企业靶场蓝图，不再强依赖显式 `topologySpec`。
- 已完成 Task 11 首轮收口：实例页创建流程已升级为“创建并启动”，并限制仅可选择已发布模板。
- 已完成 Task 12 首轮收口：实例详情页已补任务可观测性增强，包括当前阶段、运行洞察、最近失败步骤和重试动作文案。
- 已完成 Task 13 首轮收口：实例失败恢复链路已补建议动作与跨页跳转，可从实例直接钻取到对应任务详情。
- 已完成 Task 14 首轮收口：失败实例已支持真正的一键恢复接口，前端失败态动作会自动改走 `retry`，后端自动判定恢复方向。
- 已完成 Task 15 首轮收口：实例详情接口已输出结构化 `recoverySummary`，前端优先展示正式恢复分类、级别、可重试标记与建议动作。
- 已完成 Task 16 首轮收口：实例列表与筛选区已接入 `recoverySummary`，支持按恢复分类筛选失败实例。
- 已完成 Task 17 首轮收口：总览页和任务页已接入恢复分类展示，首页可直接看到高频失败类型，任务页可看到关联实例的恢复分类。
- 已完成 Task 18 首轮收口：`alicloud-enterprise-range` 已升级为 provider-aware 动态模块，`network_zones + hosts + entry_host_key` 现可驱动多子网、多主机与单入口机编排，旧三段式变量仅保留兼容回退。
- 已完成 Task 19 首轮收口：模板发布前已接入结构化预检，能够在发布阶段拦截 `compiledSpec.resources[]` 的缺项、字段冲突和公网入口暴露错误。
- 已完成 Task 20 首轮收口：模板资源模型已扩展到 `nat_gateway / eip / acl / security_group_rule`，编辑器可保存这些资源，发布前也会校验其引用关系。
- 已完成 Task 21 首轮收口：OpenTofu 编排已开始消费模板中的 `nat_gateway / eip` 资源，且这些输入来源于 `compiledSpec.resources[]`，不再依赖额外硬编码默认字段。
- 已完成 Task 22 首轮收口：OpenTofu 编排已开始消费模板中的 `security_group_rule` 资源；`acl` 仍保留在模板与预检层，等待云侧资源语义验证后再接执行。
- 已完成验证：
  - `pnpm --filter @aliyun-cyber-range/api test -- admin-resources.e2e-spec.ts`
  - `pnpm --filter @aliyun-cyber-range/api test -- admin-resource-validation.e2e-spec.ts`
  - `pnpm --filter @aliyun-cyber-range/api test -- provisioning-worker-concurrency.e2e-spec.ts`
  - `pnpm --filter @aliyun-cyber-range/api test -- enterprise-provision-plan.spec.ts open-tofu-range-provisioner.e2e-spec.ts provisioning-worker-concurrency.e2e-spec.ts`
  - `pnpm --filter @aliyun-cyber-range/api test -- enterprise-provision-plan.spec.ts provisioning-worker-concurrency.e2e-spec.ts open-tofu-range-provisioner.e2e-spec.ts`
  - `pnpm --filter @aliyun-cyber-range/web test -- components/admin/range-instances-screen.test.tsx`
  - `pnpm --filter @aliyun-cyber-range/web test -- components/admin/overview-screen.test.tsx components/admin/provision-jobs-screen.test.tsx components/admin/range-instances-screen.test.tsx`
  - `pnpm --filter @aliyun-cyber-range/web test -- components/admin/range-instances-screen.test.tsx`
  - `pnpm --filter @aliyun-cyber-range/web test -- components/admin/range-instances-screen.test.tsx components/admin/provision-jobs-screen.test.tsx`
  - `pnpm --filter @aliyun-cyber-range/api test -- range-instances-retry.spec.ts provisioning-worker-concurrency.e2e-spec.ts`
  - `pnpm --filter @aliyun-cyber-range/api test -- range-instance-recovery.spec.ts range-instances-retry.spec.ts provisioning-worker-concurrency.e2e-spec.ts`
  - `pnpm --filter @aliyun-cyber-range/api test -- enterprise-provision-plan.spec.ts open-tofu-range-provisioner.e2e-spec.ts`
  - `pnpm --filter @aliyun-cyber-range/api test -- provisioning-worker-concurrency.e2e-spec.ts`
  - `pnpm --filter @aliyun-cyber-range/api test -- range-templates-publish-precheck.e2e-spec.ts enterprise-provision-plan.spec.ts open-tofu-range-provisioner.e2e-spec.ts provisioning-worker-concurrency.e2e-spec.ts`
  - `pnpm --filter @aliyun-cyber-range/web test -- components/admin/template-editor/template-editor-screen.test.tsx lib/template-compiler.test.ts`
  - `pnpm --filter @aliyun-cyber-range/web test -- components/admin/range-instances-screen.test.tsx`
  - `pnpm --filter web test -- --runInBand apps/web/components/admin/template-editor/template-editor-screen.test.tsx`
  - `pnpm --filter @aliyun-cyber-range/web test -- components/admin/template-editor/template-editor-screen.test.tsx lib/template-compiler.test.ts lib/template-topology-sync.test.ts`
- 已完成的关键提交：
  - `91f9ed4 feat: add extensible topology graph fields`
  - `a1043fe fix: finalize template versioning migration and guardrails`
  - `66f4c17 feat: compile topology graph into template spec`
  - `776938a fix: narrow template compiled spec payload`
  - `e89f22f test: harden template compiler coverage`
  - `e4d7d59 feat: add enterprise topology skeleton bootstrap`

## 下一步执行起点

- 当前计划文档中的 Task 1 到 Task 8 已进入“已完成或已完成首轮闭环”状态。
- 当前计划文档中的 Task 1 到 Task 18 已进入“已完成或已完成首轮闭环”状态。
- 当前主线不再是“有没有模板编辑器”，而是“让发布模板成为真实编排蓝图的唯一可信来源”。
- 下一阶段应继续深化业务闭环：把“统一资源图驱动编排”继续做实，补 ACL 等剩余网络资源的云侧接入，并进入真实阿里云企业靶场回归。

### Task 18: 升级 enterprise-range 模块输入为 provider-aware 结构

**Status:** 已完成首轮收口

- 已完成内容：
  - `enterprise-provision-plan` 已输出 `entryHostKey`、`networkZones[]`、`hostDefinitions[]`，把模板拓扑中的多区域、多主机、入口机语义显式化。
  - `OpenTofuRangeProvisioner` 写入的 tfvars 已新增 `entry_host_key`、`network_zones`、`hosts`，同时保留 `dmz_cidr` / `office_cidr` / `server_cidr` 与对应私网 IP 兼容字段。
  - `alicloud-enterprise-range` 模块已改为动态 `for_each` 模式，按模板资源创建多 vSwitch、多 ECS 和单 EIP 入口。
  - 模块已新增入口机存在性与唯一性检查，避免 `entry_host_key` 缺失或多个公网候选时静默选错主机。
  - OpenTofu e2e 测试已切到新输出结构，`resource_summary.host_ids` 现按模板 host key 回写，而不是旧的 `dmz/office/server` 约定键。

- 已完成验证：
  - `pnpm --filter @aliyun-cyber-range/api test -- enterprise-provision-plan.spec.ts open-tofu-range-provisioner.e2e-spec.ts`
  - `pnpm --filter @aliyun-cyber-range/api test -- provisioning-worker-concurrency.e2e-spec.ts`

- 当前意义：
  - 这一步把“模板资源描述”真正落到了“云资源创建输入”上，平台已经不再被固定三段骨架绑死。
  - 下一步可以继续做发布前结构化预检，确保模板在发布前就能发现资源缺项、入口配置冲突、区域引用错误等问题。

### Task 19: 在模板发布阶段接入结构化预检

**Status:** 已完成首轮收口

- 已完成内容：
  - `RangeTemplatesService.publish()` 现会在 `compiledSpec.topology` 一致性检查之外，继续校验 `compiledSpec.resources[]` 对模板蓝图的覆盖情况。
  - 当前已拦截三类高价值错误：
    - 拓扑里声明的交换机或主机在 `compiledSpec.resources[]` 中缺失
    - 编译态 host/switch 与 `topologySpec` 的关键字段冲突，包括 `cidr`、`zoneKey`、`role`、`privateIp`
    - 入口主机未显式标记为 `exposePublic=true`
  - 预检失败时后端会返回结构化 `message[]`，方便后续直接映射到编辑器侧错误面板，而不是只给单条字符串。
  - 模板编辑器发布动作已接住这类结构化错误，当前会在页面状态区直接展示逐条拼接后的中文失败提示。
  - 已新增服务层定向测试，避免当前受限环境下 `supertest` 端口监听限制影响这条主线校验。

- 已完成验证：
  - `pnpm --filter @aliyun-cyber-range/api test -- range-templates-publish-precheck.e2e-spec.ts enterprise-provision-plan.spec.ts open-tofu-range-provisioner.e2e-spec.ts provisioning-worker-concurrency.e2e-spec.ts`

- 当前意义：
  - 这一步把“模板发布”从单纯的状态切换升级成了真正的质量闸门，很多会在云侧失败的蓝图现在可以更早暴露。
  - 下一步最自然的是把这些结构化预检结果回传到模板编辑器，并继续扩展到 NAT、ACL、更多主机类型等资源模型。

### Task 20: 扩展模板资源模型到 NAT / EIP / ACL / 安全组规则

**Status:** 已完成首轮收口

- 已完成内容：
  - 模板编辑器节点模型已从 `host / switch / router` 扩到 `nat_gateway / eip / acl / security_group_rule`。
  - 节点库、属性面板、草稿反序列化和新增节点工厂都已支持这些新资源，管理员现在可以在模板中显式保存云侧网络控制资源。
  - `compileTopologyGraph()` 已能把这些节点稳定编译进 `compiledSpec.resources[]`，保持统一 provider-aware 资源表达。
  - 发布前结构化预检已新增引用校验：
    - `nat_gateway.zoneKey` 必须指向已声明网络区域
    - `eip.bindTargetType/bindTargetKey` 必须指向已存在 host 或 nat gateway
    - `acl.zoneKey` 必须指向已声明网络区域
    - `security_group_rule.targetHostKey` 必须指向已声明主机
  - 现阶段这些资源只进入模板表达与发布预检链路，尚未让 OpenTofu 模块真正消费，这样可以先稳住模板能力而不打断现有编排闭环。

- 已完成验证：
  - `pnpm --filter @aliyun-cyber-range/api test -- range-templates-publish-precheck.e2e-spec.ts enterprise-provision-plan.spec.ts open-tofu-range-provisioner.e2e-spec.ts provisioning-worker-concurrency.e2e-spec.ts`
  - `pnpm --filter @aliyun-cyber-range/web test -- components/admin/template-editor/template-editor-screen.test.tsx lib/template-compiler.test.ts`

- 当前意义：
  - 这一步把模板从“多子网多主机拓扑”推进到了“可描述真实云网络控制资源”的层级，为后续综合渗透靶场编排打下了资源模型底座。
  - 下一步最自然的是让 OpenTofu 和阿里云模块真正消费其中一部分资源，优先顺序建议为 `nat_gateway -> eip -> acl/security group rule`。

### Task 21: 让 OpenTofu 开始消费模板中的 NAT / EIP 资源

**Status:** 已完成首轮收口

- 已完成内容：
  - `enterprise-provision-plan` 现会从 `compiledSpec.resources[]` 中提取 `nat_gateway / eip` 资源，并生成当前阶段所需的 provider 输入视图。
  - `OpenTofuRangeProvisioner` 写入的 tfvars 已新增 `nat_gateways` 与 `eips`，它们的值全部从模板编译产物推导而来，而不是单独维护第二套配置源。
  - `alicloud-enterprise-range` 模块已新增：
    - 动态 `alicloud_nat_gateway`
    - 动态 `alicloud_eip_address`
    - 按目标类型拆分的 host / nat gateway EIP 关联
  - 模块已保留兼容回退：如果模板没有显式给入口主机创建 EIP 资源，仍会自动补一个入口 EIP，保持现有“公网入口主机”语义不被打断。
  - `resource_summary` 已开始回写 `nat_gateway_ids` 和 `eip_allocation_ids`，为后续实例详情排障和资源追踪打底。

- 已完成验证：
  - `pnpm --filter @aliyun-cyber-range/api test -- range-templates-publish-precheck.e2e-spec.ts enterprise-provision-plan.spec.ts open-tofu-range-provisioner.e2e-spec.ts provisioning-worker-concurrency.e2e-spec.ts`

- 当前意义：
  - 这一步完成了“模板中声明的云网络控制资源”第一次真正进入编排执行层，平台已经不再只会按固定三机骨架创建资源。
  - 这仍然是统一资源图驱动编排的第一阶段落地，后续还需要继续减少专用字段视图、把更多资源类型按同一模式接入，并补真实云侧回归验证。

### Task 22: 让 OpenTofu 开始消费模板中的安全组规则资源

**Status:** 已完成首轮收口

- 已完成内容：
  - `enterprise-provision-plan` 现会从 `compiledSpec.resources[]` 中提取 `security_group_rule` 资源。
  - `OpenTofuRangeProvisioner` 写入的 tfvars 已新增 `security_group_rules`，继续保持“全部来自模板编译产物”的单一事实来源。
  - `alicloud-enterprise-range` 模块已把原本硬编码的默认 SSH/HTTP 规则改造成“默认规则回退 + 模板规则优先”的动态 `alicloud_security_group_rule`。
  - 当前仍保持共享安全组模型：模板中的 `targetHostKey` 先作为规则归属语义存在，实际仍落到统一安全组上，后续若要做更细粒度隔离，需要继续演进到按主机拆分安全组。
  - `acl` 资源目前仍只进入模板、编译与发布前预检链路，尚未接到 OpenTofu 执行层；这样可以避免在未验证 provider 资源语义前引入不可靠实现。

- 已完成验证：
  - `pnpm --filter @aliyun-cyber-range/api test -- range-templates-publish-precheck.e2e-spec.ts enterprise-provision-plan.spec.ts open-tofu-range-provisioner.e2e-spec.ts provisioning-worker-concurrency.e2e-spec.ts`

- 当前意义：
  - 这一步把第二类真实云网络控制资源接入了执行层，平台已经可以从模板直接影响安全组放行规则，而不是只依赖模块硬编码默认策略。
  - `acl` 的真实 provider 语义验证和带 NAT/EIP/安全组规则的阿里云 smoke test 已完成，当前资源驱动链路已在云侧真实通过。
  - 下一步最关键的是继续减少专用派生字段、扩展更多资源类型，并把“模板资源图 -> OpenTofu 资源图”的统一映射继续做厚。

### Task 6: 打通 `TopologyGraph -> compiledSpec` 的最小编译闭环

**Status:** 已完成

- 已完成内容：
  - 新增前端最小编译器 `apps/web/lib/template-compiler.ts`
  - 保存草稿时同时提交 `compiledSpec`
  - `compiledSpec` 收敛为最小载荷：`schemaVersion + resources[]`
  - `resources[].config` 已按 `host/switch/router` 白名单字段稳定编译
  - 编译器已补穷尽保护，未知节点类型会显式抛错
  - 已新增 `apps/web/lib/template-compiler.test.ts`，锁定三类节点的稳定 shape

- 已完成验证：
  - `pnpm --filter @aliyun-cyber-range/web test -- components/admin/template-editor/template-editor-screen.test.tsx lib/template-compiler.test.ts`

- 已完成提交：
  - `66f4c17 feat: compile topology graph into template spec`
  - `776938a`（Task 6 规格收窄修正）

**Files:**
- Create: `apps/web/lib/template-compiler.ts`
- Modify: `apps/web/components/admin/template-editor/template-editor-screen.tsx`
- Modify: `apps/web/components/admin/template-editor/template-editor-screen.test.tsx`
- Modify: `apps/web/lib/admin-types.ts`

- [x] **Step 1: 先写失败测试，定义保存草稿时会同时提交 `compiledSpec`**

```tsx
it('compiles topology graph into compiledSpec when saving draft', async () => {
  fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));

  await waitFor(() => {
    expect(updateRangeTemplateMock).toHaveBeenCalledWith(
      'http://localhost:3001',
      'dev-admin-token',
      'template-1',
      expect.objectContaining({
        compiledSpec: expect.objectContaining({
          schemaVersion: '1.0.0',
          resources: expect.arrayContaining([
            expect.objectContaining({ id: 'host-1', type: 'host' }),
          ]),
        }),
      }),
    );
  });
});
```

- [x] **Step 2: 运行测试，确认先失败**

Run: `pnpm --filter @aliyun-cyber-range/web test -- components/admin/template-editor/template-editor-screen.test.tsx`

Expected: FAIL，当前保存草稿还没有稳定生成 `compiledSpec`。

- [x] **Step 3: 新建最小编译器，把节点列表编译为通用资源数组**

```ts
export function compileTopologyGraph(input: { nodes: TemplateNode[]; topologySpec?: RangeTemplateTopologySpec | null }) {
  return {
    schemaVersion: '1.0.0',
    resources: input.nodes.map((node) => ({
      id: node.id,
      type: node.kind,
      provider: 'alibaba_cloud',
      config: node,
    })),
    topologySpec: input.topologySpec ?? null,
  };
}
```

- [x] **Step 4: 编辑器保存草稿时同时提交 `topologyGraph + compiledSpec`**

```tsx
const compiledSpec = compileTopologyGraph({
  nodes,
  topologySpec,
});

await updateRangeTemplate(apiBaseUrl, session.token, template.id, {
  topologyGraph,
  compiledSpec,
  topologySpec,
});
```

- [x] **Step 5: 重新运行测试，确认转绿**

Run: `pnpm --filter @aliyun-cyber-range/web test -- components/admin/template-editor/template-editor-screen.test.tsx`

Expected: PASS，保存草稿会提交稳定的 `compiledSpec`。

- [x] **Step 6: Commit**

### Task 7: 企业靶场默认骨架生成器

**Status:** 已完成首轮闭环

- 已完成补充内容：
  - 新增 `apps/web/lib/template-topology-sync.ts`，保存草稿时会基于当前节点自动回写 `topologySpec`
  - 后端发布阶段已校验 `compiledSpec.topology` 与 `topologySpec` 的关键字段一致性
  - 当前已锁定四项一致性约束：`vpcCidr`、`publicEntryHostKey`、`networkZoneKeys`、`hostKeys`

**Files:**
- Create: `apps/web/lib/template-topology-skeleton.ts`
- Modify: `apps/web/components/admin/template-editor/template-editor-screen.tsx`
- Modify: `apps/web/components/admin/template-editor/template-editor-screen.test.tsx`

- [x] **Step 1: 先写失败测试，定义编辑器可一键生成企业靶场默认骨架**

```tsx
it('bootstraps an enterprise range skeleton into the editor', async () => {
  render(<TemplateEditorScreen template={templateFixture} />);

  fireEvent.click(screen.getByRole('button', { name: '生成企业骨架' }));

  expect(screen.getByRole('button', { name: /DMZ 交换机/ })).toBeTruthy();
  expect(screen.getByRole('button', { name: /办公网主机/ })).toBeTruthy();
  expect(screen.getByRole('button', { name: /数据库主机/ })).toBeTruthy();
  expect(screen.getByRole('button', { name: /公网出口路由/ })).toBeTruthy();
});
```

- [x] **Step 2: 运行测试，确认先失败**

Run: `pnpm --filter @aliyun-cyber-range/web test -- components/admin/template-editor/template-editor-screen.test.tsx`

Expected: FAIL，编辑器尚无“一键生成企业骨架”入口。

- [x] **Step 3: 新建默认骨架生成器，返回标准企业靶场节点集**

```ts
export function createEnterpriseRangeSkeleton(): TemplateNode[] {
  return [
    { id: 'switch-dmz', kind: 'switch', label: 'DMZ 交换机', zoneKey: 'dmz', cidr: '10.70.10.0/24', purpose: 'public-entry', enableNat: false },
    { id: 'switch-office', kind: 'switch', label: '办公区交换机', zoneKey: 'office', cidr: '10.70.20.0/24', purpose: 'user-workstations', enableNat: false },
    { id: 'switch-server', kind: 'switch', label: '服务器区交换机', zoneKey: 'server', cidr: '10.70.30.0/24', purpose: 'application-servers', enableNat: false },
    { id: 'host-dmz-entry', kind: 'host', label: 'DMZ 入口主机', zoneKey: 'dmz', role: 'entry', privateIp: '10.70.10.10', exposePublic: true, image: 'aliyun_linux_3_x64_20G_alibase' },
    { id: 'host-office-client', kind: 'host', label: '办公网主机', zoneKey: 'office', role: 'workstation', privateIp: '10.70.20.10', exposePublic: false, image: 'aliyun_linux_3_x64_20G_alibase' },
    { id: 'host-server-db', kind: 'host', label: '数据库主机', zoneKey: 'server', role: 'db', privateIp: '10.70.30.20', exposePublic: false, image: 'aliyun_linux_3_x64_20G_alibase' },
    { id: 'router-egress', kind: 'router', label: '公网出口路由', routeRole: 'egress', egressType: 'internet', bindEip: true },
  ];
}
```

- [x] **Step 4: 在编辑器工具栏加入“生成企业骨架”，注入默认节点**

```tsx
<button type="button" onClick={handleBootstrapEnterpriseSkeleton}>生成企业骨架</button>
```

```tsx
function handleBootstrapEnterpriseSkeleton() {
  const nextNodes = createEnterpriseRangeSkeleton();
  setNodes(nextNodes);
  setSelectedNodeId(nextNodes[0]?.id ?? null);
  setStatusMessage('已生成企业靶场默认骨架');
}
```

- [x] **Step 5: 重新运行测试，确认转绿**

Run: `pnpm --filter @aliyun-cyber-range/web test -- components/admin/template-editor/template-editor-screen.test.tsx`

Expected: PASS，编辑器可一键注入标准企业靶场默认拓扑节点。

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/template-topology-skeleton.ts \
  apps/web/components/admin/template-editor/template-editor-screen.tsx \
  apps/web/components/admin/template-editor/template-editor-screen.test.tsx
git commit -m "feat: add enterprise topology skeleton bootstrap"
```

```bash
git add apps/web/lib/template-compiler.ts \
  apps/web/components/admin/template-editor/template-editor-screen.tsx \
  apps/web/components/admin/template-editor/template-editor-screen.test.tsx \
  apps/web/lib/admin-types.ts
git commit -m "feat: compile topology graph into template spec"
```

### Task 8: 让编排优先消费已发布 `compiledSpec` 产物

**Status:** 已完成首轮收口

- 已完成内容：
  - `ProvisioningWorkerService` 现在会优先读取 `currentPublishedVersion.compiledSpec.topologySpec`
  - 若已发布版本没有编译态拓扑，才回退到 `currentPublishedVersion.topologySpec`
  - 仅在已发布版本两者都缺失时，才回退模板顶层 `template.topologySpec`
  - 已补并跑通并发 worker 测试，锁定“编排优先消费发布编译产物”的行为

- 已完成验证：
  - `pnpm --filter @aliyun-cyber-range/api test -- provisioning-worker-concurrency.e2e-spec.ts`

- 当前意义：
  - 这一步把“编辑器保存/发布的模板蓝图”和“后端真实编排消费的蓝图”接到了同一条主链路上
  - 还没有直接消费 `compiledSpec.resources[]`，但已经完成从“旧模板字段主导”向“发布编译产物主导”的第一步迁移

### Task 9: 引入企业靶场标准 `provision plan` 层

**Status:** 已完成首轮收口

- 已完成内容：
  - 新增 `apps/api/src/provisioning/enterprise-provision-plan.ts`
  - 将企业靶场网络/主机解析从 `OpenTofuRangeProvisioner` 中抽离为独立计划构建层
  - `DryRunRangeProvisioner` 与 `OpenTofuRangeProvisioner` 已统一消费这层标准计划
  - 现阶段标准计划已稳定表达：资源名前缀、模块路径、拓扑摘要、三大网络区、三台关键主机

- 已完成验证：
  - `pnpm --filter @aliyun-cyber-range/api test -- enterprise-provision-plan.spec.ts open-tofu-range-provisioner.e2e-spec.ts provisioning-worker-concurrency.e2e-spec.ts`

- 当前意义：
  - 这一步把后端从“直接散读 topologySpec 字段”推进到“先生成标准编排计划，再交给具体 provisioner 执行”
  - 后续如果要支持更多节点类型、更多区域或多云 provider，扩展点将优先落在 `provision plan` 层，而不是把规则继续堆进具体执行器里

### Task 10: 让 `provision plan` 直接消费 `compiledSpec.resources[]`

**Status:** 已完成首轮收口

- 已完成内容：
  - 扩展 `buildEnterpriseProvisionPlan`，支持从 `compiledSpec.resources[]` 反向重建企业靶场所需的最小蓝图
  - `ProvisioningWorkerService` 现在会同时向 provisioner 传入 `compiledSpec` 与 `topologySpec`
  - 当已发布模板没有 `compiledSpec.topologySpec` 时，后端仍可基于 `resources[] + topology.vpcCidr` 继续构建编排计划
  - `DryRunRangeProvisioner` 与 `OpenTofuRangeProvisioner` 已统一消费这条新链路

- 已完成验证：
  - `pnpm --filter @aliyun-cyber-range/api test -- enterprise-provision-plan.spec.ts provisioning-worker-concurrency.e2e-spec.ts open-tofu-range-provisioner.e2e-spec.ts`

- 当前意义：
  - 已发布模板的编译产物开始具备“独立驱动编排”的能力，后端不再把 `topologySpec` 当成唯一可信来源
  - 下一步可以顺势进入“模板发布后实例创建闭环”，而不是继续只做底层字段搬运

### Task 11: 打通实例页“创建并启动”最小业务闭环

**Status:** 已完成首轮收口

- 已完成内容：
  - 实例页创建表单现在只展示已发布模板
  - 管理员点击创建后，前端会立即触发 `create` 任务，不再停留在“先建草稿、再手工发起创建”
  - 创建成功后，实例详情会立即切入 `pending_create` 状态，并挂接最近一次任务
  - 页面会在后台刷新实例详情，继续拉取后续入口、资源摘要与任务步骤

- 已完成验证：
  - `pnpm --filter @aliyun-cyber-range/web test -- components/admin/range-instances-screen.test.tsx`

- 当前意义：
  - 这一步把“选模板 -> 创建实例 -> 启动编排”的管理员主路径连成了一次操作
  - 下一步可以继续补“任务执行中的可观测性”和“失败后的恢复动作”，而不是继续停留在静态管理页

### Task 12: 增强实例详情页的任务可观测性与恢复提示

**Status:** 已完成首轮收口

- 已完成内容：
  - 实例详情新增“当前阶段”，可直接看到当前跑到哪一个步骤
  - 实例详情新增“运行洞察”，聚合失败原因、入口 IP 和步骤消息
  - 实例详情新增“最近失败步骤”，可直接看到失败步骤名、摘要和错误输出
  - 失败态动作文案已调整为“重试创建 / 重试销毁”，比通用“发起创建 / 发起销毁”更明确

- 已完成验证：
  - `pnpm --filter @aliyun-cyber-range/web test -- components/admin/range-instances-screen.test.tsx`

- 当前意义：
  - 这一步把实例页从“只展示最终字段”提升成“可用于排障和恢复判断”的后台工作页
  - 下一步可以继续补真正的失败恢复链路和跨页面联动，而不是仅靠人工阅读任务日志

### Task 13: 补失败恢复建议与实例页到任务页的联动跳转

**Status:** 已完成首轮收口

- 已完成内容：
  - 实例详情会基于失败摘要、步骤消息和错误输出生成恢复建议
  - 当前已覆盖实例规格不可售、资源配额不足、凭证/环境变量缺失、Provider 包缺失、模板蓝图异常等常见恢复方向
  - 实例详情新增“查看任务详情”按钮，可直接跳转到对应任务
  - 编排任务页已支持通过 `jobId` 查询参数自动展开对应任务详情

- 已完成验证：
  - `pnpm --filter @aliyun-cyber-range/web test -- components/admin/range-instances-screen.test.tsx components/admin/provision-jobs-screen.test.tsx`

- 当前意义：
  - 这一步把“看到失败”推进到“知道下一步该怎么恢复，并能一键进入对应任务时间线”
  - 下一步可以继续补真正的自动恢复策略，而不是只做人工排障辅助

### Task 14: 打通失败实例的最小一键恢复链路

**Status:** 已完成首轮收口

- 已完成内容：
  - 后端新增 `POST /admin/range-instances/:id/retry`，仅允许 `create_failed` / `destroy_failed` 实例调用
  - `retry` 作业会继承失败实例的恢复方向，自动判定是重试创建还是重试销毁
  - `retry` 作业会记录递增的 `retryCount`
  - 实例页失败态动作现在会自动走 `retry`，不再把“重试创建/重试销毁”伪装成普通 `create/destroy`

- 已完成验证：
  - `pnpm --filter @aliyun-cyber-range/api test -- range-instances-retry.spec.ts provisioning-worker-concurrency.e2e-spec.ts`
  - `pnpm --filter @aliyun-cyber-range/web test -- components/admin/range-instances-screen.test.tsx components/admin/provision-jobs-screen.test.tsx`

- 当前意义：
  - 这一步把恢复能力从“给建议、给跳转”推进到“真正可点击执行的恢复动作”
  - 下一步可以继续补恢复策略的分类结果持久化和更细粒度的恢复分流，而不是只靠即时规则判断

### Task 15: 输出结构化 `recoverySummary` 并让前端优先消费

**Status:** 已完成首轮收口

- 已完成内容：
  - 后端新增 `buildRangeRecoverySummary`，会基于实例失败状态、最近任务和步骤日志输出结构化恢复摘要
  - 当前恢复摘要已包含：`category`、`severity`、`canRetry`、`summary`、`suggestions`
  - 实例详情接口已透传 `recoverySummary`
  - 实例页优先展示后端返回的正式恢复摘要，并在 `canRetry=false` 时自动禁用恢复按钮

- 已完成验证：
  - `pnpm --filter @aliyun-cyber-range/api test -- range-instance-recovery.spec.ts range-instances-retry.spec.ts provisioning-worker-concurrency.e2e-spec.ts`
  - `pnpm --filter @aliyun-cyber-range/web test -- components/admin/range-instances-screen.test.tsx components/admin/provision-jobs-screen.test.tsx`

- 当前意义：
  - 这一步把恢复判断从“前端即时猜测”升级成“后端正式输出的恢复结论”
  - 下一步可以继续把恢复摘要持久化或纳入任务筛选，而不是每次详情加载时临时计算

### Task 16: 在实例列表层接入恢复分类与筛选

**Status:** 已完成首轮收口

- 已完成内容：
  - 实例列表现在会展示每个实例的恢复分类
  - 筛选区新增“恢复分类筛选”，可按规格容量、资源配额、云凭证配置、Provider / Runner 配置、模板蓝图等维度过滤
  - 后端列表接口现在也会为每个实例附带 `recoverySummary`

- 已完成验证：
  - `pnpm --filter @aliyun-cyber-range/api test -- range-instance-recovery.spec.ts range-instances-retry.spec.ts provisioning-worker-concurrency.e2e-spec.ts`
  - `pnpm --filter @aliyun-cyber-range/web test -- components/admin/range-instances-screen.test.tsx`

- 当前意义：
  - 这一步把恢复分类从“详情页可见”推进到“列表页可运营”，管理员能批量识别同类失败
  - 下一步可以继续把同样的分类能力接到任务页和总览页，而不是只停留在实例管理页

### Task 17: 在总览页和任务页接入恢复分类展示

**Status:** 已完成首轮收口

- 已完成内容：
  - 总览页新增“高频失败分类”卡片，可直接看到当前失败主要集中在哪一类
  - 总览页异常实例列表已展示恢复分类
  - 任务页列表和任务详情都已显示关联实例的恢复分类

- 已完成验证：
  - `pnpm --filter @aliyun-cyber-range/web test -- components/admin/overview-screen.test.tsx components/admin/provision-jobs-screen.test.tsx components/admin/range-instances-screen.test.tsx`

- 当前意义：
  - 这一步把恢复分类从“实例管理能力”推进到“后台全局态势感知能力”
  - 下一步可以继续做任务页按恢复分类筛选和更高层的恢复统计，而不是只展示文本标签

---

## 代码结构预定稿

- Modify: `packages/database/prisma/schema.prisma`
  - 为模板版本化补齐正式字段与关系，补数据库持久化结构
- Modify: `apps/api/src/admin/admin.repository.ts`
  - 统一模板/模板版本/拓扑图/编译产物的仓储类型
- Modify: `apps/api/src/database/prisma-admin.repository.ts`
  - 实现模板创建、草稿更新、发布、实例引用的数据库逻辑
- Modify: `apps/api/src/admin/dto/range-template.dto.ts`
  - 调整模板 DTO，支持更通用的拓扑图与编译产物输入
- Modify: `apps/api/src/admin/range-templates.service.ts`
  - 增加发布逻辑、草稿校验、节点/拓扑兼容校验
- Modify: `apps/api/src/admin/range-templates.controller.ts`
  - 增加 `POST /admin/range-templates/:id/publish`
- Modify: `apps/api/src/admin/range-instances.service.ts`
  - 强制实例只引用已发布模板版本
- Modify: `apps/api/src/provisioning/provisioning-worker.service.ts`
  - 编排执行改为优先读取已发布版本
- Modify: `apps/api/test/support/create-memory-admin-repository.ts`
  - 内存仓储支持模板版本化，用于 e2e
- Modify: `apps/api/test/admin-resources.e2e-spec.ts`
  - 覆盖模板创建、草稿/发布、实例执行引用发布版本
- Modify: `apps/api/test/admin-resource-validation.e2e-spec.ts`
  - 适配“模板必须先发布”规则
- Modify: `apps/api/test/admin-provisioning-failure.e2e-spec.ts`
  - 适配失败用例的模板发布前置
- Create: `apps/web/app/admin/templates/[templateId]/page.tsx`
  - 模板编辑页路由入口
- Create: `apps/web/components/admin/template-editor/template-editor-screen.tsx`
  - 模板编辑器页面容器
- Create: `apps/web/components/admin/template-editor/template-node-palette.tsx`
  - 左侧节点素材库
- Create: `apps/web/components/admin/template-editor/template-canvas.tsx`
  - 中央拓扑画布骨架
- Create: `apps/web/components/admin/template-editor/template-property-panel.tsx`
  - 右侧属性面板骨架
- Modify: `apps/web/lib/admin-types.ts`
  - 对齐模板版本、拓扑图、编译产物类型
- Modify: `apps/web/lib/admin-api.ts`
  - 增加模板发布、模板详情、模板版本相关 API
- Modify: `apps/web/components/admin/settings/settings-screen.tsx`
  - 模板列表接入版本化响应，并提供“进入编辑器/发布”入口
- Modify: `apps/web/components/admin/settings/templates-panel.tsx`
  - 调整模板卡片展示，显示草稿/发布状态
- Test: `apps/web/components/admin/settings/settings-screen.test.tsx`
- Test: `apps/web/components/admin/template-editor/template-editor-screen.test.tsx`

### Task 1: 收口模板版本化后端模型

**Status:** 已完成

**Files:**
- Modify: `packages/database/prisma/schema.prisma`
- Modify: `apps/api/src/admin/admin.repository.ts`
- Modify: `apps/api/src/database/prisma-admin.repository.ts`
- Modify: `apps/api/test/support/create-memory-admin-repository.ts`
- Test: `apps/api/test/admin-resources.e2e-spec.ts`
- Test: `apps/api/test/provisioning-worker-concurrency.e2e-spec.ts`

- [x] **Step 1: 先写失败测试，定义模板创建即带草稿版本**

```ts
it('creates a template with a draft version pointer', async () => {
  const response = await request(app.getHttpServer())
    .post('/admin/range-templates')
    .set('authorization', 'Bearer dev-admin-token')
    .send({
      name: 'Enterprise Practice Range',
      slug: 'enterprise-practice-range',
      version: 'v1',
      modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
      topologySpec: fixtureTopologySpec,
    })
    .expect(201);

  expect(response.body).toEqual(
    expect.objectContaining({
      currentDraftVersionId: expect.any(String),
      currentPublishedVersionId: null,
      currentDraftVersion: expect.objectContaining({
        status: 'draft',
        version: 'v1',
      }),
    }),
  );
});
```

- [x] **Step 2: 运行测试，确认先失败**

Run: `pnpm --filter @aliyun-cyber-range/api test -- admin-resources.e2e-spec.ts provisioning-worker-concurrency.e2e-spec.ts`

Expected: FAIL，返回体仍是单层模板，没有 `currentDraftVersionId` / `currentDraftVersion`。

- [ ] **Step 3: 扩数据库结构，加入模板版本关系与指针**

```prisma
enum RangeTemplateVersionStatus {
  draft
  published
  archived
}

model RangeTemplate {
  currentDraftVersionId     String? @unique
  currentPublishedVersionId String? @unique
  versions                  RangeTemplateVersion[]
  currentDraftVersion       RangeTemplateVersion? @relation("RangeTemplateCurrentDraftVersion", fields: [currentDraftVersionId], references: [id], onDelete: SetNull)
  currentPublishedVersion   RangeTemplateVersion? @relation("RangeTemplateCurrentPublishedVersion", fields: [currentPublishedVersionId], references: [id], onDelete: SetNull)
}

model RangeTemplateVersion {
  id              String  @id @default(cuid())
  templateId      String
  version         String
  status          RangeTemplateVersionStatus @default(draft)
  modulePathOrRef String
  topologySpec    Json?
  compiledSpec    Json?
  variableSchema  Json
  outputSchema    Json
  defaultNetworkPolicy Json?
  template        RangeTemplate @relation(fields: [templateId], references: [id], onDelete: Cascade)
}
```

- [x] **Step 4: 在仓储层实现“创建模板自动建首个草稿版本”**

```ts
async createRangeTemplate(input: CreateRangeTemplateInput): Promise<RangeTemplateRecord> {
  return this.prisma.$transaction(async (tx) => {
    const template = await tx.rangeTemplate.create({
      data: {
        name: input.name,
        slug: input.slug,
        version: input.version,
        cloudProvider: input.cloudProvider ?? 'alibaba_cloud',
        iacType: input.iacType ?? 'opentofu',
        modulePathOrRef: input.modulePathOrRef,
        topologySpec: input.topologySpec as Prisma.InputJsonValue,
        variableSchema: (input.variableSchema ?? {}) as Prisma.InputJsonValue,
        outputSchema: (input.outputSchema ?? {}) as Prisma.InputJsonValue,
      },
    });

    const draftVersion = await tx.rangeTemplateVersion.create({
      data: {
        templateId: template.id,
        version: input.version,
        status: 'draft',
        modulePathOrRef: input.modulePathOrRef,
        topologySpec: input.topologySpec as Prisma.InputJsonValue,
        compiledSpec: (input.compiledSpec ?? null) as Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput,
        variableSchema: (input.variableSchema ?? {}) as Prisma.InputJsonValue,
        outputSchema: (input.outputSchema ?? {}) as Prisma.InputJsonValue,
      },
    });

    await tx.rangeTemplate.update({
      where: { id: template.id },
      data: { currentDraftVersionId: draftVersion.id },
    });

    return tx.rangeTemplate.findUniqueOrThrow({
      where: { id: template.id },
      include: {
        currentDraftVersion: true,
        currentPublishedVersion: true,
        versions: true,
      },
    }) as unknown as RangeTemplateRecord;
  });
}
```

- [x] **Step 5: 内存仓储同步支持版本模型**

```ts
const draftVersion: RangeTemplateVersionRecord = {
  id: nextId(),
  templateId: record.id,
  version: input.version,
  status: 'draft',
  modulePathOrRef: input.modulePathOrRef,
  topologySpec: input.topologySpec,
  createdAt: now(),
  updatedAt: now(),
};

record.currentDraftVersionId = draftVersion.id;
record.currentDraftVersion = clone(draftVersion);
record.currentPublishedVersionId = null;
record.currentPublishedVersion = null;
record.versions = [clone(draftVersion)];
```

- [x] **Step 6: 重新运行测试，确认转绿**

Run: `pnpm --filter @aliyun-cyber-range/api test -- admin-resources.e2e-spec.ts provisioning-worker-concurrency.e2e-spec.ts`

Expected: PASS，模板返回草稿版本指针；并发 worker 测试仍通过。

- [x] **Step 7: Commit**

```bash
git add packages/database/prisma/schema.prisma \
  apps/api/src/admin/admin.repository.ts \
  apps/api/src/database/prisma-admin.repository.ts \
  apps/api/test/support/create-memory-admin-repository.ts \
  apps/api/test/admin-resources.e2e-spec.ts \
  apps/api/test/provisioning-worker-concurrency.e2e-spec.ts
git commit -m "feat: add template version foundation"
```

### Task 2: 打通模板发布流程与实例只引用已发布版本

**Status:** 已完成

**Files:**
- Modify: `apps/api/src/admin/range-templates.controller.ts`
- Modify: `apps/api/src/admin/range-templates.service.ts`
- Modify: `apps/api/src/admin/range-instances.service.ts`
- Modify: `apps/api/src/provisioning/provisioning-worker.service.ts`
- Modify: `apps/api/test/admin-resources.e2e-spec.ts`
- Modify: `apps/api/test/admin-resource-validation.e2e-spec.ts`
- Modify: `apps/api/test/admin-provisioning-failure.e2e-spec.ts`

- [ ] **Step 1: 先写失败测试，定义 publish 语义**

```ts
it('publishes a template and forks a fresh draft version', async () => {
  const response = await request(app.getHttpServer())
    .post(`/admin/range-templates/${templateId}/publish`)
    .set('authorization', 'Bearer dev-admin-token')
    .expect(200);

  expect(response.body).toEqual(
    expect.objectContaining({
      currentPublishedVersionId: expect.any(String),
      currentDraftVersionId: expect.any(String),
      currentPublishedVersion: expect.objectContaining({ status: 'published', version: 'v1' }),
      currentDraftVersion: expect.objectContaining({ status: 'draft', version: 'v1' }),
    }),
  );
});
```

- [ ] **Step 2: 先写失败测试，定义实例必须引用已发布模板**

```ts
it('rejects creating a range instance from an unpublished template', async () => {
  await request(app.getHttpServer())
    .post('/admin/range-instances')
    .set('authorization', 'Bearer dev-admin-token')
    .send({ competitionId, teamId, templateId: unpublishedTemplateId })
    .expect(409);
});
```

- [ ] **Step 3: 运行测试，确认先失败**

Run: `pnpm --filter @aliyun-cyber-range/api test -- admin-resources.e2e-spec.ts admin-resource-validation.e2e-spec.ts admin-provisioning-failure.e2e-spec.ts`

Expected: FAIL，缺少 `publish` 路由，且实例仍允许直接引用未发布模板。

- [ ] **Step 4: 增加发布路由与服务实现**

```ts
@Post(':id/publish')
@HttpCode(200)
publish(@Param('id') id: string) {
  return this.rangeTemplatesService.publish(id);
}
```

```ts
async publish(id: string) {
  const existingTemplate = await this.adminRepository.getRangeTemplateById(id);

  if (!existingTemplate) {
    throw new NotFoundException('Range template not found');
  }

  const topologySpec = existingTemplate.currentDraftVersion?.topologySpec ?? existingTemplate.topologySpec;

  if (!topologySpec) {
    throw new BadRequestException('Template topology spec not found');
  }

  this.validateTopologySpec(topologySpec);

  return this.adminRepository.publishRangeTemplate(id);
}
```

- [ ] **Step 5: 在仓储层实现“发布当前草稿 + fork 新草稿”**

```ts
async publishRangeTemplate(id: string): Promise<RangeTemplateRecord> {
  return this.prisma.$transaction(async (tx) => {
    const template = await tx.rangeTemplate.findUniqueOrThrow({
      where: { id },
      include: { currentDraftVersion: true },
    });

    const publishedVersion = await tx.rangeTemplateVersion.update({
      where: { id: template.currentDraftVersion!.id },
      data: { status: 'published' },
    });

    const nextDraft = await tx.rangeTemplateVersion.create({
      data: {
        templateId: template.id,
        version: publishedVersion.version,
        status: 'draft',
        modulePathOrRef: publishedVersion.modulePathOrRef,
        topologySpec: publishedVersion.topologySpec as Prisma.InputJsonValue,
        compiledSpec: publishedVersion.compiledSpec as Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput,
        variableSchema: publishedVersion.variableSchema as Prisma.InputJsonValue,
        outputSchema: publishedVersion.outputSchema as Prisma.InputJsonValue,
      },
    });

    await tx.rangeTemplate.update({
      where: { id: template.id },
      data: {
        version: publishedVersion.version,
        modulePathOrRef: publishedVersion.modulePathOrRef,
        topologySpec: publishedVersion.topologySpec as Prisma.InputJsonValue,
        currentPublishedVersionId: publishedVersion.id,
        currentDraftVersionId: nextDraft.id,
      },
    });

    return tx.rangeTemplate.findUniqueOrThrow({
      where: { id: template.id },
      include: { currentDraftVersion: true, currentPublishedVersion: true, versions: true },
    }) as unknown as RangeTemplateRecord;
  });
}
```

- [ ] **Step 6: 实例与编排统一改为读取已发布版本**

```ts
if (!template.currentPublishedVersionId) {
  throw new ConflictException('Range template must be published before creating range instances');
}
```

```ts
const publishedVersion = template.currentPublishedVersion;
const templateModulePath = publishedVersion?.modulePathOrRef ?? template.modulePathOrRef;
const topologySpec = publishedVersion?.topologySpec ?? template.topologySpec;
```

- [ ] **Step 7: 重新运行测试，确认转绿**

Run: `pnpm --filter @aliyun-cyber-range/api test -- admin-resources.e2e-spec.ts admin-resource-validation.e2e-spec.ts admin-provisioning-failure.e2e-spec.ts`

Expected: PASS，模板必须先发布；执行只引用已发布版本。

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/admin/range-templates.controller.ts \
  apps/api/src/admin/range-templates.service.ts \
  apps/api/src/admin/range-instances.service.ts \
  apps/api/src/provisioning/provisioning-worker.service.ts \
  apps/api/test/admin-resources.e2e-spec.ts \
  apps/api/test/admin-resource-validation.e2e-spec.ts \
  apps/api/test/admin-provisioning-failure.e2e-spec.ts
git commit -m "feat: publish template versions before provisioning"
```

### Task 3: 为未来多资源类型补齐通用拓扑图与编译产物边界

**Status:** 已完成并追加收口

- 已补充：顶层模板字段与 `currentDraftVersion` 一致性。
- 已补充：非法输入负例测试与“状态未污染”验证。
- 已补充：Prisma migration、存量模板回填、回填完整性断言。

**Files:**
- Modify: `apps/api/src/admin/admin.repository.ts`
- Modify: `apps/api/src/admin/dto/range-template.dto.ts`
- Modify: `apps/api/src/admin/range-templates.service.ts`
- Modify: `apps/api/test/admin-resources.e2e-spec.ts`

- [x] **Step 1: 先写失败测试，定义模板可接受拓扑图与编译产物字段**

```ts
it('accepts topologyGraph and compiledSpec alongside topologySpec', async () => {
  const response = await request(app.getHttpServer())
    .post('/admin/range-templates')
    .set('authorization', 'Bearer dev-admin-token')
    .send({
      name: 'Hybrid Template',
      slug: 'hybrid-template',
      version: 'v1',
      modulePathOrRef: 'infra/opentofu/modules/alicloud-enterprise-range',
      topologySpec: fixtureTopologySpec,
      topologyGraph: {
        schemaVersion: '1.0.0',
        nodes: [{ id: 'switch-dmz', kind: 'switch', data: { cidr: '10.70.10.0/24' } }],
        edges: [],
      },
      compiledSpec: {
        schemaVersion: '1.0.0',
        resources: [{ id: 'switch-dmz', type: 'switch', config: { cidr: '10.70.10.0/24' } }],
      },
    })
    .expect(201);

  expect(response.body.currentDraftVersion).toEqual(
    expect.objectContaining({
      topologyGraph: expect.objectContaining({ schemaVersion: '1.0.0' }),
      compiledSpec: expect.objectContaining({ schemaVersion: '1.0.0' }),
    }),
  );
});
```

- [x] **Step 2: 运行测试，确认先失败**

Run: `pnpm --filter @aliyun-cyber-range/api test -- admin-resources.e2e-spec.ts`

Expected: FAIL，当前输入/输出没有完整透传 `topologyGraph` / `compiledSpec`。

- [x] **Step 3: 在 DTO 和仓储类型中保留通用 JSON 边界**

```ts
export type RangeTemplateVersionRecord = {
  topologyGraph?: Record<string, unknown> | null;
  compiledSpec?: Record<string, unknown> | null;
};
```

```ts
export class CreateRangeTemplateDto {
  @IsOptional()
  @IsObject()
  topologyGraph?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  compiledSpec?: Record<string, unknown>;
}
```

- [x] **Step 4: 服务层仅做最小兼容校验，不写死资源类型**

```ts
if (input.topologyGraph && typeof input.topologyGraph !== 'object') {
  throw new BadRequestException('topologyGraph must be an object');
}

if (input.compiledSpec && typeof input.compiledSpec !== 'object') {
  throw new BadRequestException('compiledSpec must be an object');
}
```

- [x] **Step 5: 重新运行测试，确认转绿**

Run: `pnpm --filter @aliyun-cyber-range/api test -- admin-resources.e2e-spec.ts`

Expected: PASS，模板草稿版本能保存并返回通用拓扑图/编译产物。

- [x] **Step 6: Commit**

```bash
git add apps/api/src/admin/admin.repository.ts \
  apps/api/src/admin/dto/range-template.dto.ts \
  apps/api/src/admin/range-templates.service.ts \
  apps/api/test/admin-resources.e2e-spec.ts
git commit -m "feat: add extensible topology graph fields"
```

### Task 4: 接 Web 端模板中心到版本化响应

**Status:** 已完成

**Files:**
- Modify: `apps/web/lib/admin-types.ts`
- Modify: `apps/web/lib/admin-api.ts`
- Modify: `apps/web/components/admin/settings/settings-screen.tsx`
- Modify: `apps/web/components/admin/settings/templates-panel.tsx`
- Test: `apps/web/components/admin/settings/settings-screen.test.tsx`

- [ ] **Step 1: 先写失败测试，定义模板列表卡片显示草稿/发布状态**

```tsx
it('shows draft and published version badges for templates', async () => {
  fetchAdminBootstrapMock.mockResolvedValue({
    competitions: [],
    teams: [],
    rangeInstances: [],
    provisionJobs: [],
    rangeTemplates: [
      {
        id: 'template-1',
        name: 'Enterprise Template',
        slug: 'enterprise-template',
        version: 'v1.1.0',
        currentDraftVersionId: 'draft-1',
        currentPublishedVersionId: 'published-1',
        currentDraftVersion: { id: 'draft-1', status: 'draft', version: 'v1.2.0' },
        currentPublishedVersion: { id: 'published-1', status: 'published', version: 'v1.1.0' },
      },
    ],
  });

  render(<SettingsScreen apiBaseUrl="http://localhost:3001" />);

  expect(await screen.findByText('已发布 v1.1.0')).toBeInTheDocument();
  expect(screen.getByText('草稿 v1.2.0')).toBeInTheDocument();
});
```

- [ ] **Step 2: 运行测试，确认先失败**

Run: `pnpm --filter @aliyun-cyber-range/web test -- components/admin/settings/settings-screen.test.tsx`

Expected: FAIL，前端类型和模板卡片仍按旧单层模板结构渲染。

- [ ] **Step 3: 扩前端模板类型与 API 封装**

```ts
export type RangeTemplateVersion = {
  id: string;
  status: 'draft' | 'published' | 'archived';
  version: string;
  topologySpec?: Record<string, unknown> | null;
  topologyGraph?: Record<string, unknown> | null;
  compiledSpec?: Record<string, unknown> | null;
};

export type RangeTemplate = {
  id: string;
  name: string;
  slug: string;
  version: string;
  currentDraftVersionId: string | null;
  currentPublishedVersionId: string | null;
  currentDraftVersion?: RangeTemplateVersion | null;
  currentPublishedVersion?: RangeTemplateVersion | null;
};
```

- [ ] **Step 4: 在模板卡片中显示发布/草稿状态并提供操作入口**

```tsx
<div className="template-version-row">
  {template.currentPublishedVersion ? <span>已发布 {template.currentPublishedVersion.version}</span> : <span>未发布</span>}
  {template.currentDraftVersion ? <span>草稿 {template.currentDraftVersion.version}</span> : null}
</div>

<div className="template-actions">
  <button type="button" onClick={() => onOpenEditor(template.id)}>进入编辑器</button>
  <button type="button" onClick={() => onPublish(template.id)} disabled={!template.currentDraftVersionId}>发布</button>
</div>
```

- [ ] **Step 5: 重新运行测试，确认转绿**

Run: `pnpm --filter @aliyun-cyber-range/web test -- components/admin/settings/settings-screen.test.tsx`

Expected: PASS，模板卡片可区分草稿与已发布版本。

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/admin-types.ts \
  apps/web/lib/admin-api.ts \
  apps/web/components/admin/settings/settings-screen.tsx \
  apps/web/components/admin/settings/templates-panel.tsx \
  apps/web/components/admin/settings/settings-screen.test.tsx
git commit -m "feat: surface template versions in admin settings"
```

### Task 5: 搭第一版模板编辑器工作区骨架

**Status:** 已完成，且已超出原骨架范围

- 实际已完成内容超过原计划：
  - 节点新增
  - 草稿拓扑读取与保存
  - `host/switch/router` 分类型属性面板
  - 编辑器内发布模板

**Files:**
- Create: `apps/web/app/admin/templates/[templateId]/page.tsx`
- Create: `apps/web/components/admin/template-editor/template-editor-screen.tsx`
- Create: `apps/web/components/admin/template-editor/template-node-palette.tsx`
- Create: `apps/web/components/admin/template-editor/template-canvas.tsx`
- Create: `apps/web/components/admin/template-editor/template-property-panel.tsx`
- Modify: `apps/web/lib/admin-api.ts`
- Modify: `apps/web/lib/admin-types.ts`
- Test: `apps/web/components/admin/template-editor/template-editor-screen.test.tsx`

- [x] **Step 1: 先写失败测试，定义编辑器基础布局**

```tsx
it('renders the topology editor workspace layout', async () => {
  render(
    <TemplateEditorScreen
      template={{
        id: 'template-1',
        name: 'Enterprise Template',
        currentDraftVersion: { id: 'draft-1', status: 'draft', version: 'v1.2.0', topologyGraph: { schemaVersion: '1.0.0', nodes: [], edges: [] } },
      }}
    />,
  );

  expect(screen.getByText('节点库')).toBeInTheDocument();
  expect(screen.getByText('拓扑画布')).toBeInTheDocument();
  expect(screen.getByText('属性面板')).toBeInTheDocument();
});
```

- [x] **Step 2: 运行测试，确认先失败**

Run: `pnpm --filter @aliyun-cyber-range/web test -- components/admin/template-editor/template-editor-screen.test.tsx`

Expected: FAIL，编辑器页面和组件尚不存在。

- [x] **Step 3: 建编辑器页面和三个核心骨架组件**

```tsx
export function TemplateEditorScreen({ template }: { template: RangeTemplate }) {
  const draft = template.currentDraftVersion;

  return (
    <section className="template-editor-shell">
      <header className="template-editor-toolbar">
        <h1>{template.name}</h1>
        <div>
          <button type="button">保存草稿</button>
          <button type="button">发布模板</button>
        </div>
      </header>
      <div className="template-editor-body">
        <TemplateNodePalette />
        <TemplateCanvas topologyGraph={draft?.topologyGraph ?? null} />
        <TemplatePropertyPanel />
      </div>
    </section>
  );
}
```

- [x] **Step 4: 节点库先只放三类节点，属性面板先只做空态**

```tsx
export function TemplateNodePalette() {
  return (
    <aside>
      <h2>节点库</h2>
      <button type="button">主机</button>
      <button type="button">交换机</button>
      <button type="button">路由器</button>
    </aside>
  );
}
```

```tsx
export function TemplatePropertyPanel() {
  return (
    <aside>
      <h2>属性面板</h2>
      <p>选择一个节点后即可编辑参数。</p>
    </aside>
  );
}
```

- [x] **Step 5: 重新运行测试，确认转绿**

Run: `pnpm --filter @aliyun-cyber-range/web test -- components/admin/template-editor/template-editor-screen.test.tsx`

Expected: PASS，编辑器布局骨架可渲染。

- [x] **Step 6: Commit**

```bash
git add apps/web/app/admin/templates/[templateId]/page.tsx \
  apps/web/components/admin/template-editor/template-editor-screen.tsx \
  apps/web/components/admin/template-editor/template-node-palette.tsx \
  apps/web/components/admin/template-editor/template-canvas.tsx \
  apps/web/components/admin/template-editor/template-property-panel.tsx \
  apps/web/components/admin/template-editor/template-editor-screen.test.tsx
git commit -m "feat: add topology editor workspace skeleton"
```

## 自检

- 覆盖检查：本计划覆盖了模板版本化、发布执行边界、未来多资源扩展字段、模板中心前端适配、编辑器基础工作区。
- 占位检查：无 `TODO` / `TBD` / “类似前文” 之类占位描述。
- 类型一致性：计划中统一使用 `RangeTemplate`、`RangeTemplateVersion`、`topologyGraph`、`compiledSpec`、`currentDraftVersion`、`currentPublishedVersion` 命名。
