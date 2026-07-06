# 靶场编排器重构实现计划

> 目标：把当前 `靶场编排` 从“已有三栏雏形但体验偏草稿的编辑器”升级为尽量贴近参考站点 `scene-detail?id=141` 的在线拓扑编排器，并让前端图数据稳定编译为现有 OpenTofu 链路可消费的结构。

> 关联设计：`docs/superpowers/specs/2026-06-30-scenario-orchestrator-design.md`

## 文档状态说明（2026-07-02）

这份计划当前仍负责：

- 编排器 UI
- 图模型
- 前端编译产物
- 与后端拓扑语义的对齐

但它不再单独覆盖“最终 Docker 部署下的 OpenTofu 执行链路”。

截至 2026-07-02，Docker / OpenTofu / provider / worker 拆分这条后端执行主线，已经拆出独立实施计划：

- [2026-07-02-docker-opentofu-provisioning-alignment-implementation-plan.md](/Users/yym/Documents/阿里云For综合靶场竞赛平台/docs/superpowers/plans/2026-07-02-docker-opentofu-provisioning-alignment-implementation-plan.md)

当前明确结论：

- `compiledProvisionSpec` 仍是实例创建的主消费对象
- 平台内实例创建链路已经推进到真实 `tofu init` 阶段
- 剩余主要问题集中在 Root wrapper、worker 容器、provider mirror 与 Docker 运行时对齐

## 0. 总体原则

- 第一阶段只支持 `单 VPC + 多 switch + 多 ECS`
- UI 只暴露 `router / switch / ecs` 三种画布节点
- NAT / ACL / 安全组等为节点内嵌配置，不再作为独立画布节点
- 创建实例一律使用最新草稿
- 发布状态只表示模板可见性，不再决定实例化数据源
- 前端编排器允许整体替换当前实现，不为旧画布和旧属性面板保兼容
- 参考平台 `scene-detail?id=140` 是本轮前端交互主蓝本
- 后端交付硬终点是：
  - `topologyGraph`
  - `scenarioTemplateSpec`
  - `compiledProvisionSpec`
  其中实例创建主消费对象是 `compiledProvisionSpec`
- 编排页布局、结构、资源面板、画布比例、属性面板组织方式，尽量参考：
  - `https://reversi-mgt.chaitin.net/targets/scenario-base/scene-detail?id=141`
- 本轮必须直接使用你提供的图标资源：
  - `/Users/yym/Downloads/Router.svg`
  - `/Users/yym/Downloads/Switch.svg`
  - `/Users/yym/Downloads/Server.svg`

## 1. 当前代码差距

已知主要差距：

- `template-canvas.tsx` 还会渲染基于 `zoneKey` 的伪关系边，不是真实拓扑
- `template-editor-screen.tsx` 还保留较多 legacy 节点默认字段与旧版本图模型心智
- `template-node-palette.tsx` 还是占位式资源列表，没有把图标和资源辨识做起来
- `template-property-panel.tsx` 还是“后台表单块”，不够像在线编排配置器
- `globals.css` 里的编排页仍明显保留通用后台卡片布局，不像参考站点工作台
- 当前节点、连线、右键配置、选中反馈、删除反馈都不够清晰

后端已确认可复用的稳定主链路：

- 模板持久化支持 `topologyGraph / scenarioTemplateSpec / compiledProvisionSpec`
- `ProvisioningWorkerService` 创建实例时优先读取 `compiledProvisionSpec`
- `buildEnterpriseProvisionPlan()` 与 `OpenTofuRangeProvisioner` 已能消费企业网资源摘要

因此本轮不应围绕“保住旧前端”，而应围绕“重建编排页并接稳后端”。

## 2. 任务拆解

## 任务 0：完成参考站点校准并冻结旧编排器心智

**目标**

- 明确后续实现不是“修旧页面”，而是按参考站点交互整体替换编排器

**涉及文件**

- `docs/superpowers/specs/2026-06-30-scenario-orchestrator-design.md`
- `docs/superpowers/plans/2026-06-30-scenario-orchestrator-implementation-plan.md`
- `apps/web/components/admin/template-editor/template-editor-screen.tsx`
- `apps/web/components/admin/template-editor/template-canvas.tsx`
- `apps/web/components/admin/template-editor/template-property-panel.tsx`

- [x] 清点现有可复用部分，仅保留：
  - 路由与页面入口
  - 模板读写调用
  - 编译触发点
- [x] 标记旧的分层列表式画布逻辑为待删除
- [x] 标记旧的多资源节点 UI 模型为待删除
- [x] 后续实现以参考站点三栏编排器为主，不再做局部修修补补
- [x] 二次审计参考站点 `scene-detail?id=141`
- [x] 把“参考站点优先于现状 UI”的要求回写到 spec / plan

当前结论：

- 保留 `template-editor-screen.tsx` 里的模板加载、保存草稿、发布编排与编译触发闭环
- 保留左栏“点击添加 router / switch / ecs”与三栏挂载骨架
- 整体重做 `template-canvas.tsx` 的连线、节点视觉、选中与右键配置体验
- 整体重做 `template-property-panel.tsx` 的配置器组织与视觉结构
- 下一步顺序锁定为：先收模型与真实边 -> 再换工作台骨架与画布 -> 再重做属性面板

## 任务 1：收敛前端图模型并清理 legacy 心智

**目标**

- 用新的 `ScenarioGraphDraft` 收住第一阶段节点模型，并去掉会误导 UI 的 legacy 字段表达

**涉及文件**

- `apps/web/lib/scenario-graph.ts`
- `apps/web/components/admin/template-editor/template-property-panel.tsx`
- `apps/web/components/admin/template-editor/template-editor-screen.tsx`
- `apps/web/lib/scenario-template-spec.ts`

- [ ] 删除第一阶段 UI 不再使用的节点类型：
  - `nat_gateway`
  - `eip`
  - `acl`
  - `security_group_rule`
  - `snat_entry`
  - `dnat_entry`
- [ ] 为 `router` 增加最简描述字段
- [ ] 为 `switch` 增加：
  - `description`
  - `aclRules[]`
  - `nat.snatEnabled`
  - `nat.dnatMappings[]`
- [ ] 为 `ecs` 增加：
  - `instanceName`
  - `hostName`
  - `cpu`
  - `memory`
  - `description`
  - `bootPriority`
  - `bootWaitSeconds`
  - `nics[]`
  - `nics[].secondaryIps[]`
  - `nics[].securityGroupRules[]`
- [ ] 停止让 `routeRole / egressType / networkInterfaces / portGroups / dnatMappings` 主导编排页的主视觉摘要
- [ ] 把 `schemaVersion` 升到当前编排器版本

当前进展：

- [x] 新增中心模型文件 `apps/web/lib/scenario-graph.ts`
- [x] 默认骨架已切到新字段：`router.description / switch.aclRules / switch.nat / ecs.instanceName / ecs.hostName / ecs.cpu / ecs.memory / ecs.nics`
- [x] `syncTopologySpecFromNodes` 已优先按 `ecs.nics[].switchId / privateIp` 推导主网卡归属
- [x] `template-editor-screen.tsx` 已切到新的中心模型读取与默认值
- [x] `template-property-panel.tsx` 已移除第一阶段之外的旧节点类型分支入口

## 任务 2：重写默认骨架与图同步

**目标**

- 让新建靶场直接进入可编辑的最小企业网骨架

**涉及文件**

- `apps/web/lib/template-topology-skeleton.ts`
- `apps/web/lib/template-topology-sync.ts`
- `apps/web/lib/admin-template-defaults.ts`

- [ ] 默认骨架改为：
  - `1 router`
  - `1 switch`
  - `1 ecs`
- [ ] 默认关系改为：
  - `router -> switch`
  - `switch -> ecs`
- [ ] 增加布局初始坐标
- [ ] 同步逻辑改为以 `switchId / nic.switchId` 为真实依赖源，而不是旧的 `zoneKey` 推断
- [ ] 骨架生成后立即可见真实节点与真实边，而不是推导关系

## 任务 3：把“画布”改成参考站点式工作台主区域

**目标**

- 让中栏成为主工作区，并在结构和比例上尽量靠近参考站点

**涉及文件**

- `apps/web/components/admin/template-editor/template-canvas.tsx`
- `apps/web/components/admin/template-editor/template-node-palette.tsx`
- `apps/web/components/admin/template-editor/template-editor-screen.tsx`
- `apps/web/app/globals.css`

- [ ] 页面去掉通用后台卡片味，收成固定工作台骨架
- [ ] 左栏资源面板加入图标与稳定资源分组
- [ ] 画布改成可视拓扑层
- [ ] 节点显示图标、名称、必要摘要
- [ ] 支持选中高亮
- [ ] 支持画布内拖动节点并持久化 `position`
- [ ] 支持显示真实边
- [ ] 删除 `buildTopologyRelations()` 这种推导边逻辑
- [ ] 连线视觉升级，不再只是普通直线
- [ ] 支持删除当前选中节点
- [ ] 删除节点时自动清理关联边和失效 NIC / DNAT 引用
- [ ] 画布占比与布局节奏参考目标站点，尽量放大中间工作区
- [ ] 顶部工具条布局参考当前 `靶场实例` 页，而不是旧编排页按钮堆叠方式
- [ ] 将 `生成第一阶段骨架` 降级为辅助动作，不再压主路径
- [ ] 资源节点启用你提供的三张图标

当前进展：

- [x] 中栏已从“分层列表摘要”切成自由布局画布板
- [x] 节点已按 `position` 绝对定位渲染
- [x] 真实边已直接渲染到 SVG 画布层
- [x] 当前页面已删除画布下方的摘要卡片、关系列表等冗余内容
- [x] 顶部工具条已压成简洁工具栏，不再保留旧 Hero 结构
- [x] 节点拖动与位置写回已接通
- [ ] 仍需把视觉和布局真正拉到参考站点级别

## 任务 4：重做节点交互与连线规则

**目标**

- 收敛为单一在线编排模式，并把选中、连线、右键配置三件事理顺

**涉及文件**

- `apps/web/components/admin/template-editor/template-editor-screen.tsx`
- `apps/web/components/admin/template-editor/template-canvas.tsx`

- [ ] 去掉最终产品里的多模式切换心智（不再区分编辑模式 / 连线模式）
- [ ] 左栏节点采用 `点击添加`
- [ ] 在单一在线编排模式下建立连接
- [ ] 只允许：
  - `router -> switch`
  - `switch -> ecs`
- [ ] 非法连接前端直接提示
- [ ] 右键节点打开属性面板
- [ ] `删除选中` 仅在有选中节点时可用
- [ ] 页面进入后默认即可开始编排，不再需要先切模式
- [ ] 收紧“选中节点”和“待连线起点”的状态表达，避免当前二者混淆
- [ ] 补节点右键后的可见反馈
- [ ] 补删除选中后的反馈与状态回收

当前进展：

- [x] 已移除 `编辑模式 / 连线模式` 顶部按钮
- [x] 节点库默认在线可用，不再需要先切模式
- [x] 单击节点可选中，再次单击当前节点可设为连线起点
- [x] 在单一在线编排模式下可完成 `router -> switch` 与 `switch -> ecs` 连线
- [x] 非法连线会直接提示拦截
- [x] 右键节点已接入属性面板打开行为
- [x] `删除选中` 已保留并仅在有选中节点时可用
- [ ] 仍需把当前“再次点击同一节点=连线起点”的逻辑整理得更明确

## 任务 5：重做属性面板

**目标**

- 按 `router / switch / ecs` 三种节点提供稳定、清晰、接近参考站点的右侧配置器

**涉及文件**

- `apps/web/components/admin/template-editor/template-property-panel.tsx`
- `apps/web/app/globals.css`

- [ ] 路由器面板：
  - 名称
  - 描述
- [ ] 交换机面板：
  - 基础信息
  - 网段配置
  - ACL 配置
  - NAT 配置
- [ ] ECS 面板：
  - 基础信息
  - 网卡配置
  - 安全规则
- [ ] `添加网卡`
- [ ] `添加 ACL 规则`
- [ ] `添加 DNAT 规则`
- [ ] 所有重复表单改成结构化子表单，而不是 JSON 文本域
- [ ] 给 ECS 面板补齐：
  - `启动优先级`
  - `启动等待时间`
- [ ] ACL 规则支持删除、优先级、策略
- [ ] DNAT 规则支持删除、目标主机清晰选择
- [ ] 网卡安全规则支持删除、优先级、策略
- [ ] CIDR 区表现得更像“网段配置”，不是单个粗糙输入框
- [ ] 未选中节点时右栏占位更轻，减少噪音

当前进展：

- [x] ECS 面板主分组已切成 `基础信息 + 网卡配置 + 初始化`
- [x] 交换机面板主分组已切成 `基础信息 + 网段配置 + ACL 配置 + NAT 配置`
- [x] `添加网卡 / 添加 ACL 规则 / 添加 DNAT 规则` 已变成真实按钮
- [x] ECS 网卡已从单个总文本域拆成卡片式子表单入口
- [x] 交换机 ACL / DNAT 已从总文本域拆成卡片式子表单入口
- [x] ECS 网卡安全规则已补到卡片层
- [ ] 仍需继续把网卡安全规则、ACL 规则、DNAT 规则再细化成更完整的字段集合与交互
- [ ] 仍需把整个右栏从“开发表单”收成“编排配置器”

## 任务 6：重写图到模板的编译转换

**目标**

- 让前端图数据直接产出当前后端接受的模板规范，并真实进入 OpenTofu 创建链路

**涉及文件**

- `apps/web/lib/topology-graph-to-scenario-template.ts`
- `apps/web/lib/scenario-template-compiler.ts`
- `apps/web/lib/template-compiler.ts`
- `apps/api/src/provisioning/enterprise-provision-plan.ts`
- `apps/api/src/provisioning/provisioning-worker.service.ts`

- [ ] 按 `router` 生成 VPC 根拓扑
- [ ] 按 `switch` 生成 `networkZones`
- [ ] 按 `ecs` 生成 `hosts`
- [ ] `switch.aclRules` -> `access.aclRules`
- [ ] `ecs.nics[].securityGroupRules` -> `access.securityGroupRules`
- [ ] `switch.nat` 自动合成：
  - NAT gateway
  - EIP
  - SNAT entries
- [ ] 创建实例继续默认吃最新草稿，而不是发布版本
- [ ] 保证右栏填写的 NIC / ACL / NAT 结构全部真实落到编译输入

## 任务 7：保存 / 发布 / 实例化闭环回归

**目标**

- 在新的参考站点式编排器上，把“保存草稿 -> 发布 -> 生成实例”主链路再跑通一轮

**涉及文件**

- `apps/web/components/admin/template-editor/template-editor-screen.tsx`
- `apps/web/components/admin/templates-screen.tsx`
- `apps/web/lib/topology-graph-to-scenario-template.ts`
- `apps/web/lib/scenario-template-compiler.ts`
- `apps/api/src/admin/range-templates.service.ts`
- `apps/api/src/admin/range-instances.service.ts`

- [ ] 保存草稿后状态反馈与页面状态一致
- [ ] 发布后状态反馈与版本状态一致
- [ ] 草稿模板也允许生成实例
- [ ] 生成实例明确使用最新草稿
- [ ] 回写实例详情和任务链路时不丢失编排结果

## 任务 8：测试与本地回归

**目标**

- 先用最少但关键的测试锁住这轮重构，再用本地页面回归真实验证

**涉及文件**

- `apps/web/components/admin/template-editor/template-editor-screen.test.tsx`
- `apps/web/components/admin/template-editor/template-canvas.test.tsx`
- `apps/web/lib/scenario-graph.test.ts`
- `apps/web/lib/template-topology-sync.test.ts`

- [ ] 先删掉或改写“依赖推导边”的旧测试
- [ ] 补“只渲染真实 edges”的测试
- [ ] 补“节点图标、资源面板分组、右键打开属性配置”的测试
- [ ] 补“ACL / DNAT / NIC 安全规则增删改”的测试
- [ ] 本地启动 `http://127.0.0.1:3100` 做真实页面回归
  - DNAT entries
- [ ] 输出字段对齐当前后端真实消费契约：
  - `topology`
  - `networkZones`
  - `hosts`
  - `natGateways`
  - `eips`
  - `snatEntries`
  - `dnatEntries`
  - `securityGroupRules`
  - `aclRules`
- [ ] 保持现有 OpenTofu renderer 不需要大改即可继续消费

当前进展：

- [x] `buildScenarioTemplateSpecFromTopologyGraph()` 已支持：
  - `switch.aclRules -> access.aclRules`
  - `switch.nat -> natGateways / eips / host.dnat`
  - `ecs.nics[].securityGroupRules -> access.securityGroupRules`
- [x] `compileTopologyGraph()` 已拒绝旧的一等节点类型，并从 `switch.nat` 派生 `snat_entry / dnat_entry`
- [x] 针对上述行为的 3 组单测已通过
- [x] `template-editor-screen.tsx` 的读写入口已对齐到新模型

## 任务 7：保存、发布、复制、实例化行为对齐

**目标**

- 让编排页的按钮语义真正成立

**涉及文件**

- `apps/web/components/admin/templates-screen.tsx`
- `apps/web/components/admin/template-editor/template-editor-screen.tsx`
- `apps/web/lib/admin-api.ts`

- [ ] 保存草稿时保存最新 `ScenarioGraphDraft`
- [ ] 发布模板时基于当前草稿做编译校验
- [ ] 复制模板时复制最新草稿蓝图
- [ ] 生成实例时使用最新草稿，不要求先发布
- [ ] 若草稿未通过编译，禁止创建实例并给出错误原因

## 任务 8：校验与错误提示

**目标**

- 把错误尽量拦在前端，不把用户推给 OpenTofu 日志

**涉及文件**

- `apps/web/lib/template-topology-sync.ts`
- `apps/web/components/admin/template-editor/template-editor-screen.tsx`

- [ ] 单路由器约束
- [ ] 至少一个交换机
- [ ] ECS 至少一张网卡
- [ ] 网卡必须绑定交换机
- [ ] 同交换机私网 IP 不冲突
- [ ] DNAT 仅允许映射到当前交换机下 ECS
- [ ] DNAT 公网端口冲突校验

## 任务 9：测试补齐

**目标**

- 给这次重构留下最小但有效的回归网

**涉及文件**

- `apps/web/components/admin/template-editor/template-editor-screen.test.tsx`
- `apps/web/components/admin/template-editor/template-property-panel.test.tsx`（新建）
- `apps/web/lib/topology-graph-to-scenario-template.test.ts`（新建或补齐）
- `apps/api/test/open-tofu-range-provisioner.e2e-spec.ts`

- [ ] 图模型转换单测
- [ ] 交换机 ACL / NAT 编译单测
- [ ] ECS 多网卡 / 安全组规则编译单测
- [ ] 画布新增 / 选中 / 删除 / 连线交互测试
- [ ] 草稿实例化链路测试

## 任务 10：前后端联调与 smoke

**目标**

- 用前端真实编排产物跑通一次完整链路

- [ ] 本地前端创建一个：
  - `1 router`
  - `3 switch`
  - `3 ecs`
  - 至少一条 DNAT
  - 至少一个 SNAT 开关
- [ ] 保存并发布模板
- [ ] 直接用草稿创建实例
- [ ] 验证任务日志与实例详情
- [ ] 验证该实例创建调用真实走过：
  - `compiledProvisionSpec`
  - `buildEnterpriseProvisionPlan()`
  - `OpenTofuRangeProvisioner.create()`
- [ ] 在授权窗口内做一次受控阿里云 smoke test 并立即销毁资源

## 3. 推荐执行顺序

1. 收敛图模型
2. 改默认骨架与同步
3. 整页替换画布与连接交互
4. 整页替换属性面板
5. 重写编译器
6. 打通保存 / 发布 / 实例化
7. 补测试
8. 做 smoke

## 4. 完成定义

满足以下条件才算完成：

- `靶场编排` 页面可以真正编辑拓扑，而不是只改列表
- 三类节点都能新增、删除、连线、改属性
- Switch 能配置网段 / ACL / SNAT / DNAT
- ECS 能配置镜像占位、规格、主机名、多网卡、固定私网 IP、安全组规则
- 编排结果可稳定转成现有 OpenTofu 输入
- 草稿模板可以直接创建实例
- 至少一次本地联调和一次受控云侧 smoke 成功
