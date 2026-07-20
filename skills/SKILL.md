---
name: aliyun-cyber-range-operations
description: 通过 aliyun-cyber-range-platform MCP Server 安全查询、创建、控制和清理阿里云综合靶场资源。当用户要查询靶场模板、整套综合靶场、平台镜像、独立靶机、可用实例规格或作业，创建、销毁、重试、重启、打包或导出实例，管理平台用户，或更新云配置时使用；执行意图路由、参数契约、权限边界、资源清理和敏感数据规则。
---

# 阿里云综合靶场操作

通过 `aliyun-cyber-range-platform` MCP Server 操作平台。保持最小权限、最小查询范围和可追踪的资源生命周期。

## 运行时事实源

以当前会话实际暴露的 MCP 工具名、说明、输入 schema 和可见 scope 判断“能否调用”。构造参数时同时读取 [tool-contracts.md](./references/tool-contracts.md)；其中 `single_instance_spec_check` 的类型化 schema 是 CPU/内存校验的事实源。未来若 MCP 发布了与契约冲突的类型化 schema，以类型化 schema 为准。

工具未暴露或当前 scope 不足时，停止操作并说明具体缺口。不要尝试未暴露的替代接口。

## 严格禁止（NEVER）

- 平台资源操作仅调用 MCP；连通性和权限验证优先使用只读工具。
- 不要编造资源 ID、scope、实例状态或权限。用户未提供的必填创建参数须补问；仅使用本 Skill 明确标注的服务端默认值。
- 未获用户明确授权 smoke test 时，不得为测试连通性、权限或工具行为发起创建、销毁或修改。
- 工具可见不代表可以操作任意资源；不要试图绕过服务端的 owner/admin 校验。
- 不要在未经明确请求的情况下获取密码、SSH 连接信息、VNC URL 或凭据 CSV。

## 严格要求（MUST）

- 先按动作和资源域选择工具；范围、目标、权限或影响不清楚时，先澄清，不要猜选工具。
- 先用范围最小的 `list`/`get` 定位 ID，再执行动作；显示名称只能帮助定位，不能代替 ID。
- 按工具契约和当前类型化 schema（如存在）构造参数；只传用户明确要求、服务端默认或工具必需的字段。
- 所有写操作都需要用户对准确目标和影响范围的明确授权。仅当服务端实际返回 `confirmationId` 时，才遵循其二阶段确认流程。
- 仅当当前工具 schema 或服务端响应要求 `idempotencyKey` 时传入；参数改变时绝不复用旧键。
- 创建独立靶机前，读取 [instance-specifications.md](./references/instance-specifications.md)，并在首次创建调用前用相同 CPU/内存执行 `single_instance_spec_check`。结果不是 `exactAvailable: true`、校验报错，或 CPU/内存随后改变时，均不得调用 `single_instance_batch_launch`。
- 对授权的 smoke test 使用最小资源集，达到验证条件后立即销毁，并确认终态。

## 意图路由

| 用户要处理的对象 | 工具域 | 典型动作 |
|---|---|---|
| 靶场模板 | `range_template_*` | 列表、查看模板、作为整套靶场启动来源 |
| 整套综合靶场 | `range_instance_*` | 启动、查询、获取授权访问、完整销毁 |
| 平台镜像资产 | `platform_image_*` | 查询、收录、重命名、发布、停用、删除 |
| 独立训练靶机 | `single_instance_*` | 批量创建、查询、重试、重启、打包、导出、销毁 |
| 独立靶机规格/可用性 | `single_instance_spec_check` | 以 CPU、内存校验单实例执行器支持性和当前可售性。 |
| 异步开通任务 | `provision_job_get` | 查询已知 `provisionJobId` 的进度和失败详情 |
| 用户或云配置 | `admin_user_*`、`cloud_config_*` | 仅限实际具备管理员 scope 的明确管理请求 |

动作优先于名词。遇到“实例”“镜像”“关闭”“访问”“重试”等歧义词，先读取 [intent-guide.md](./references/intent-guide.md) 并只提出必要的澄清问题。

关键区分：

- “创建实例”可能是基于模板启动整套靶场，也可能是基于平台镜像创建独立靶机。
- “查看访问”可能是普通详情，也可能是密码、SSH 或 VNC 等敏感访问数据。
- “镜像”可能是收录已有快照、把单实例打包成私有镜像，或变更平台镜像的可见性。
- “销毁”必须区分单台靶机、整批靶机和整套综合靶场；平台没有通用的“关闭”替代动作。

## 核心流程

1. 识别用户的动作、资源域和影响范围；存在歧义时只读取 [intent-guide.md](./references/intent-guide.md) 并先澄清，不加载写操作或敏感输出规则。
2. 查看当前 MCP 工具和 scope；构造参数时读取 [tool-contracts.md](./references/tool-contracts.md)。
3. 按场景加载必要规则并执行最小操作：创建独立靶机读取 [instance-specifications.md](./references/instance-specifications.md) 和 [write-operations.md](./references/write-operations.md)，写操作读取 [write-operations.md](./references/write-operations.md)，敏感输出读取 [sensitive-outputs.md](./references/sensitive-outputs.md)。
4. 返回资源 ID、scope、状态和下一步安全操作。异步操作只能报告“已受理”或“进行中”，直到资源或作业进入终态。

## 按需加载的参考

| 场景 | 读取文件 |
|---|---|
| 选择工具、核对参数、scope 或写入属性 | [tool-contracts.md](./references/tool-contracts.md) |
| 意图不清，或涉及实例/镜像/关闭/访问/重试等易混淆表达 | [intent-guide.md](./references/intent-guide.md) |
| 创建独立靶机，或用户询问 CPU/内存/磁盘/数量/可用规格 | [instance-specifications.md](./references/instance-specifications.md) |
| 已明确目标与影响的创建、销毁、修改、重试、重启、打包、用户管理或云配置 | [write-operations.md](./references/write-operations.md) |
| 请求或处理密码、SSH、VNC、AccessKey、Token 或凭据 CSV | [sensitive-outputs.md](./references/sensitive-outputs.md) |
| MCP 调用失败、超时、确认响应或状态不一致 | [error-handling.md](./references/error-handling.md) |

只读 list/get 请求不加载写操作、规格或敏感输出规则；不要为了“保险”而一次读取全部参考文件。

## 输出约束

报告已使用的资源 ID、非敏感状态、影响范围和下一步。除非用户明确请求且有权接收，否则脱敏密码、Token、AccessKey、VNC URL 和 CSV 凭据行。
