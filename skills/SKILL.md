---
name: aliyun-cyber-range-operations
description: 通过 aliyun-cyber-range-platform MCP Server 管理云上综合靶场平台：镜像中心、实例管理、靶场编排、编排实例、用户管理、账单费用和基础配置。用于安全查询、创建、控制、发布和清理平台资源。
---

# 云上综合靶场平台全产品 Skill

通过 `aliyun-cyber-range-platform` MCP Server 操作平台。入口负责产品路由、安全边界和统一流程；进入产品参考后，先按其中的“产品内意图路由”选择具体功能，再读取对应参数、约束和流程。

> ⚠️ **运行时 MCP 工具列表、输入 schema 和 scope 是唯一事实源。** 工具未暴露、schema 未接受或 scope 不足时，停止并说明缺口；不要改用 HTTP API、数据库、云厂商 CLI 或其它身份绕过限制。

## 严格禁止（NEVER DO）

- 仅通过 MCP 操作平台资源；不得调用未暴露的替代接口。
- 不编造资源 ID、scope、实例状态、镜像 ID、规格、密码或服务端默认值；通过最小范围的 `list`/`get` 获取事实。
- 未获用户明确授权，不创建、修改、发布、销毁、导出或获取凭据；工具可见不等于可越权操作。
- 创建或替换靶场模板拓扑时，必须先执行 `range-authoring` 的“设计转换 Skill”流程；不得把自然语言设计、`topologySpec`、`scenarioTemplateSpec`、`compiledProvisionSpec` 或 `compiledSpec` 直接作为 MCP 创建参数。
- 不把“关闭”擅自解释为重启或销毁；必须确认是单实例、批次还是整套编排靶场。
- 不在摘要、日志、Skill 文件或后续回复中回显密码、Token、SSH/VNC 链接、AccessKey 或凭据 CSV 内容。

## 严格要求（MUST DO）

- 先根据动作和资源域路由到一个产品，再阅读对应产品参考；含糊请求只提出必要澄清。
- 写操作必须具有用户对准确目标和影响范围的明确授权。平台实际返回 `confirmationId` 时，才执行二阶段确认。
- 仅当 schema 或服务端响应要求时传 `idempotencyKey`；同一业务请求保持稳定，目标或参数变化则重新授权并使用新键。
- 创建、重试、销毁或打包后，只能报告“已受理”，直至查询到资源或作业终态。
- 需要访问密码、SSH、VNC 或导出凭据时，必须同时阅读 [敏感输出规则](./references/sensitive-outputs.md)。
- 授权 smoke test 使用最小资源集；达到验证条件后立即销毁并确认终态。

## 产品总览

| 产品 | 用途 | MCP 工具域 | 参考文件 |
|---|---|---|---|
| `image-center` 镜像中心 | 查询、收录、重命名、启停、发布或删除平台镜像 | `platform_image_*` | [image-center.md](./references/products/image-center.md) |
| `instance-management` 实例管理 | 基于平台镜像创建、查询、控制、打包和销毁独立靶机 | `single_instance_*` | [instance-management.md](./references/products/instance-management.md) |
| `range-authoring` 靶场编排 | 设计转换、创建、检测并保存、发布和取消发布综合靶场模板 | `range_template_*` | [range-authoring.md](./references/products/range-authoring.md) |
| `range-instances` 编排实例 | 启动、查看、修改、控制、访问和销毁整套靶场环境 | `range_instance_*` | [range-instances.md](./references/products/range-instances.md) |
| `user-management` 用户管理 | 管理平台用户、角色、状态和密码 | `admin_user_*` | [user-management.md](./references/products/user-management.md) |
| `billing` 账单费用 | 查看平台费用与成本信息 | 当前未暴露 MCP 工具 | [billing.md](./references/products/billing.md) |
| `settings` 基础配置 | 查询和更新平台云配置 | `cloud_config_*` | [settings.md](./references/products/settings.md) |

异步开通任务属于所有资源域的通用支撑能力：使用 `provision_job_get`，见 [全局运行时规则](./references/global-reference.md) 和 [错误处理](./references/error-handling.md)。

## 意图判断决策树

- 用户提到“镜像、快照、收录镜像、启用镜像、发布镜像” → `image-center`
- 用户提到“单台靶机、训练主机、CPU/内存、批量创建、VNC、打包镜像” → `instance-management`
- 用户提到“拓扑、模板、编排、交换机、ECS 节点、NAT、检测并保存、发布模板” → `range-authoring`
- 用户提到“整套靶场、环境、基于模板启动、实例拓扑变更、节点开关机、销毁靶场” → `range-instances`
- 用户提到“平台用户、角色、禁用、重置密码” → `user-management`
- 用户提到“账单、费用、成本” → `billing`
- 用户提到“云配置、地域、可用区、AccessKey、基础配置” → `settings`

关键区分：

- “创建实例”：提到模板/拓扑/环境时是 `range-instances`；提到平台镜像、CPU、内存、数量时是 `instance-management`。
- “镜像”：收录快照和管理镜像是 `image-center`；由独立靶机生成镜像是 `instance-management`。
- “访问实例”：查询状态使用产品的 `list`/`get`；明确索要密码、SSH 或 VNC 才属于敏感输出。
- “重试”：仅用于创建或销毁失败；运行中的实例使用重启，不可互相替代。
- “模板发布”与“启动靶场”：前者是 `range-authoring` 的可见性/版本操作，后者是 `range-instances` 的云资源创建。

更多模糊请求见 [intent-guide.md](./references/intent-guide.md)。

## 危险操作确认

以下操作在已有明确意图之外，还必须展示“操作 + 准确目标 ID + 影响范围/不可逆后果”并取得用户确认。确认后仅在平台也要求时传 `confirmationId`。

| 产品 | 操作 | 风险 |
|---|---|---|
| 镜像中心 | 收录、重命名、启用/停用、发布/取消发布、删除镜像 | 创建或改变镜像资产的名称、可用性、可见性，或永久删除资产 |
| 实例管理 | 创建批次、销毁单台/整批、重启、打包镜像、导出 CSV、打开 VNC | 产生云资源、释放资源、改变运行态或暴露凭据 |
| 靶场编排 | 发布到平台、取消发布、删除模板 | 改变平台可见性或删除可复用资产 |
| 编排实例 | 启动、应用变更、同步模板、节点开关机/重启、打包镜像、销毁整套靶场、获取访问凭据 | 创建或改变云资源、模板资产，或暴露敏感数据 |
| 用户管理 | 创建用户、角色/状态变更、密码重置 | 改变访问权限或身份凭据 |
| 基础配置 | 更新云配置 | 影响后续所有云资源操作，且可能涉及密钥 |

保存用户明确要求的完整模板或实例拓扑不需要额外二次确认，但必须通过 MCP 编译校验；发布到平台、取消发布、应用实例变更、同步模板、节点控制、打包镜像和删除始终属于危险操作。

完整确认格式、服务端确认和幂等规则见 [confirmation.md](./references/confirmation.md)。

## 核心流程

1. **意图分类**：先判断动词与资源域；含糊的“实例、镜像、关闭、访问、重试”按决策树澄清。
2. **能力核对**：确认当前 MCP 暴露目标工具、其 schema 与当前 scope；读取 [global-reference.md](./references/global-reference.md)。
3. **阅读产品参考**：加载该产品文档；只有涉及敏感输出、确认或错误时，再加载相应通用参考。
4. **定位目标与前置条件**：用最小 `list`/`get` 获取 ID，核对 owner/visibility、状态、镜像或模板可见性。
5. **授权与执行**：先完成危险操作确认；严格按 schema 和产品流程调用 MCP，不猜测参数。
6. **跟踪终态**：异步响应返回后，用资源详情或 `provision_job_get` 跟踪；失败仅按当前状态允许的流程处理。
7. **安全交付**：报告非敏感 ID、状态、影响范围和下一步；授权 smoke test 成功后立即清理资源。

## 详细参考（按需读取）

- [products/](./references/products/)：7 个导航产品的工具、参数、前置条件和流程。
- [global-reference.md](./references/global-reference.md)：运行时 schema、scope、ID、异步作业与通用输出规则。
- [intent-guide.md](./references/intent-guide.md)：易混淆意图的细分路由。
- [confirmation.md](./references/confirmation.md)：危险操作确认、`confirmationId` 与 `idempotencyKey`。
- [sensitive-outputs.md](./references/sensitive-outputs.md)：密码、SSH、VNC、Token 与 CSV 处理。
- [error-handling.md](./references/error-handling.md)：认证、权限、校验、超时和异步失败处理。
