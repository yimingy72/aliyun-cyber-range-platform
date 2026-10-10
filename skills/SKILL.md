---
name: aliyun-cyber-range-operations
description: 通过 aliyun-cyber-range-platform MCP Server 操作云上综合靶场平台。当用户提供 RangeDesign/v1、要求创建或修改靶场模板/模板拓扑，或需要管理镜像中心、独立实例、编排实例、平台用户、账单费用和云基础配置时使用。模板请求必须先加载本 Skill、完成设计校验与转换，随后才能调用 MCP 工具。
---

# 云上综合靶场平台全产品 Skill

通过 `aliyun-cyber-range-platform` MCP Server 操作平台。入口负责前端模块路由和跨模块安全规则；模块内的工具、参数、状态约束和流程全部在对应产品参考中完整定义。当前产品参考覆盖 Server 已注册的 86 个 MCP 工具。

> ⚠️ **运行时 MCP `tools/list`、工具的 `inputSchema`、`outputSchema`、`annotations` 和当前 scope 是唯一事实源。** 运行时 schema 与静态参考冲突时，以 schema 为准。

## 模板创建硬路由

只要请求包含 `RangeDesign/v1`、YAML 靶场设计、模板、模板拓扑、VPC、交换机、ECS、NAT、ACL、DNAT 或“检测并保存”，都必须在**任何** MCP 调用前加载本 Skill，并路由到 `range-authoring`。不得先尝试 `range_template_create`、列模板、克隆模板、查询镜像或查询云配置。

严格按以下顺序执行：

1. **解析设计**：将用户输入按拒绝重复映射键的 YAML 解析器解析为完整 `RangeDesign/v1`。顶层与嵌套键、数组、对象、枚举、CIDR、IP、端口、ACL、DNAT 和连接均须完整、可解析；每个数组项必须有自己的 `-` 列表标记。`connections` 必须是 `{ key, from, to }` 对象，不能是 `a -> b` 字符串。旧设计中的 `template.slug`、云厂商、IaC 和模块路径仅兼容读取，转换时丢弃，绝不传给 MCP。
2. **解析失败即停止**：出现截断字段、无效 YAML、缺失字段、未知图节点、重复 IP 或歧义镜像名时，只返回精确缺项/错误路径，请求修正设计；不得查询资源、猜测补全、试探调用、克隆模板或改用其他 MCP 工具。
3. **读取靶场编排参考**：完整阅读 [靶场编排](./references/products/range-authoring.md)，只调用 `platform_image_list` 解析镜像。不得为了模板创建调用 `cloud_config_get`。
4. **转换与创建**：仅调用一次 `platform_image_list` 解析所有镜像；由转换 Skill 生成完整 `topologyGraph`，并以 `range_template_create` 的运行时 schema 传入名称、描述、网络元数据和拓扑。默认地域与可用区由后端基础配置注入，转换结果和 MCP 入参都不得包含它们。
5. **不做参数试错**：`slug`、云厂商、IaC 类型、模块路径和所有派生规格均由平台管理，绝不能作为创建参数。每份转换回执只允许一次 `range_template_create`；创建 schema、编译器或服务端返回校验错误时，立即停止并报告原始错误与转换回执，不得通过删改字段、克隆、收录镜像或检测保存绕过。

## 严格禁止（NEVER DO）

- 仅通过 MCP 操作平台资源；不得调用 HTTP API、数据库、云厂商 CLI 或其它未暴露接口。
- 不编造资源 ID、scope、实例状态、镜像 ID、规格、密码、到期时间或服务端默认值；通过最小范围的 `list`/`get` 获取事实。
- 未获用户明确授权，不创建、修改、发布、销毁、导出或获取凭据；工具可见不等于可越权操作。
- 不把“关闭”擅自解释为重启或销毁；必须确认是单实例、批次还是整套编排靶场。
- 不在摘要、日志、Skill 文件或后续回复中回显密码、Token、SSH/VNC 链接、AccessKey 或凭据 CSV 内容。

## 严格要求（MUST DO）

- 先按用户意图路由到一个前端模块，再完整阅读该模块的产品参考。
- 写操作必须具有用户对准确目标和影响范围的明确授权；用户授权、运行时 schema 和平台确认是独立条件。
- 仅当 schema 或服务端响应要求时传 `idempotencyKey`；同一业务请求保持稳定，目标或参数变化则重新授权并使用新键。
- 创建、重试、销毁、更新或打包的响应只能说明“已受理”，直到查询到资源或作业终态。
- 用户明确请求密码、SSH、VNC 或凭据 CSV 时，再阅读 [敏感输出规则](./references/sensitive-outputs.md)。
- 授权 smoke test 使用最小资源集；达到验证条件后立即销毁并确认终态。
- 厂商与主账号共同确定独立数据工作空间。使用当前已验证空间，不能借切换复用其它空间的镜像、模板、实例、用户或账单 ID；后台任务继续使用受理时冻结的空间。

## 前端模块总览

| 前端模块 | 路由标识 | 用途 | 参考文件 |
|---|---|---|---|
| 镜像中心 | `image-center` | 平台镜像、云镜像目录和导入任务管理 | [image-center.md](./references/products/image-center.md) |
| 实例管理 | `instance-management` | 基于平台镜像创建、查询、控制、打包和销毁独立靶机 | [instance-management.md](./references/products/instance-management.md) |
| 靶场编排 | `range-authoring` | 设计转换、创建、检测并保存、发布和回退为私有综合靶场模板 | [range-authoring.md](./references/products/range-authoring.md) |
| 编排实例 | `range-instances` | 从模板启动、查看、修改、控制、访问和销毁整套靶场 | [range-instances.md](./references/products/range-instances.md) |
| 用户管理 | `user-management` | 管理平台用户、角色、状态和密码 | [user-management.md](./references/products/user-management.md) |
| 账单费用 | `billing` | 查询、同步和导出平台费用与成本信息 | [billing.md](./references/products/billing.md) |
| 基础配置 | `settings` | 绑定厂商账号、显式切换工作空间和维护地域配置 | [settings.md](./references/products/settings.md) |

异步开通任务是所有模块的通用支撑能力：使用 `provision_job_get({ provisionJobId })` 跟踪开通、更新、销毁和打包任务。

| 操作 | MCP 工具 | 必填参数 | 可选参数 | Scope | 用途 |
|---|---|---|---|---|---|
| 查询异步任务 | `provision_job_get` | `provisionJobId` | `includeEvidence: boolean` | `jobs:read` | 查询异步任务状态与脱敏失败摘要；`includeEvidence: true` 读取同来源资源库存、固定阶段状态、相关作业与计费台账释放时间。仅为平台记录，不等于独立云 API 回执或最终账单。 |

## 意图判断决策树

- 用户提到“镜像中心、平台镜像、快照、收录、启用、停用、发布镜像、导入镜像” → `image-center`
- 用户提到“实例管理、独立靶机、训练主机、CPU、内存、批量创建、单实例 VNC、打包独立实例镜像” → `instance-management`
- 用户提到“RangeDesign/v1、靶场编排、模板、拓扑、交换机、ECS 节点、VPC、NAT、ACL、检测并保存、发布模板” → `range-authoring`
- 用户提到“编排实例、整套靶场、靶场环境、基于模板启动、实例拓扑变更、节点开关机、销毁靶场” → `range-instances`
- 用户提到“用户管理、平台用户、角色、禁用、启用账号、重置密码” → `user-management`
- 用户提到“账单费用、成本、用户费用、账单同步、费用导出、异常费用” → `billing`
- 用户提到“基础配置、默认地域、可用区、云账号、AccessKey” → `settings`

### 易混淆请求

- “创建实例”：基于模板、拓扑或整套环境时是编排实例；基于平台镜像、CPU、内存、数量时是实例管理。无法判断时只问一次：要基于模板启动整套靶场，还是基于镜像创建独立靶机？
- “镜像”：纳入云快照、镜像资产可见性和导入任务属于镜像中心；从运行实例生成镜像属于实例管理或编排实例。
- “关闭、删除、回收”：确认范围是单台实例、一个批次还是整套编排靶场；没有通用“关机”工具。
- “访问”：`list`/`get` 只用于查询状态；明确索要密码、SSH、VNC 或 CSV 才进入敏感输出流程。
- “重试”：只能用于创建或销毁失败；运行中的独立实例重启使用 `reboot`，不能互相替代。
- “模板发布”改变其他用户的可见性；“启动靶场”才会创建一整套云资源。

## 运行时规则

1. 每次调用前确认当前工具可见、scope 足够且 `inputSchema` 接受所传参数。工具未暴露或被 scope 过滤时停止，不得回退。
2. 显示名称只能帮助定位，不能代替 ID。写操作前以同模块最小 `list`/`get` 获取目标 ID、owner、visibility 和状态。
3. 不要扩大查询范围；优先使用当前用户可见范围、已知 ID 或最窄视图。
4. 获得 `provisionJobId` 后使用 `provision_job_get({ provisionJobId })` 查询进度和失败详情；网络超时或结果未知时，先查询资源或作业，不得盲目重试。
5. MCP 工具结构化输出均为 `{ result: ... }`。`outputSchema` 描述稳定业务字段；只报告非敏感 ID、状态、影响范围和下一步。

## 危险操作确认

以下操作在已有明确意图外，必须展示“操作 + 准确目标 ID + 影响范围/不可逆后果”，并取得用户确认：

| 模块 | 操作 |
|---|---|
| 镜像中心 | 收录、重命名、启用/停用、发布/取消发布、创建全局标签定义、替换标签关联、删除镜像、删除自定义云镜像、重试导入 |
| 实例管理 | 创建批次、销毁单台/整批、重启、打包镜像、导出 CSV、打开 VNC |
| 靶场编排 | 发布到平台、回退为私有、删除模板 |
| 编排实例 | 启动、应用变更、同步模板、节点开关机/重启、DNS 核验/重新下发、打包镜像、销毁、获取访问凭据 |
| 用户管理 | 创建用户、角色/状态变更、重置密码 |
| 账单费用 | 同步账单、导出费用 CSV |
| 基础配置 | 绑定/更新云账号、更新云配置 |

调用前先用只读工具核对目标、状态、可见性和权限；参数、目标、范围或到期时间变化时重新展示摘要并获得新确认。

平台可能直接接受操作，也可能返回 `CONFIRMATION_REQUIRED`、`confirmationId` 和可选 `idempotencyKey`：

```text
用户明确授权
  -> 首次 MCP 调用
  -> 若直接接受：跟踪资源或作业终态
  -> 若返回 CONFIRMATION_REQUIRED：核对摘要
       -> 用户再次确认
       -> 相同业务参数 + 返回的 confirmationId 再次调用
```

- `confirmationId` 只能使用服务端实际返回的值，不能猜测、复用或跨资源使用。
- schema 或响应要求幂等键时，同一请求复用同一 `idempotencyKey`；参数变化时使用新键。
- 模板创建、模板编辑、检测并保存模板拓扑、保存实例拓扑已获得用户明确要求时无需额外人工二次确认，但 MCP 必须编译校验通过。

## 核心流程

1. **意图分类**：先判断用户的动词和目标前端模块，不要仅按“实例”“镜像”等名词猜测。
2. **精准路由**：选择一个模块；用户明确要求多项独立操作时，分模块执行。
3. **充分阅读参考**：完整阅读所选模块文档；涉及敏感数据或错误时按需阅读对应通用参考。
4. **能力与目标核对**：用当前 MCP tool definition 和最小 `list`/`get` 确认 schema、scope、ID、状态和可见性。
5. **执行与跟踪**：取得所需授权后严格按 schema 调用；异步结果跟踪至终态。
6. **安全交付**：只报告非敏感状态与影响范围；smoke test 达标后立即清理。

## 详细参考（按需读取）

- [products/](./references/products/)：七个前端模块的工具、参数、前置条件和流程；路由后必须完整阅读对应文件。
- [sensitive-outputs.md](./references/sensitive-outputs.md)：密码、SSH、VNC、Token 与 CSV 的最小披露规则。
- [error-handling.md](./references/error-handling.md)：认证、权限、校验、超时和异步失败处理。
