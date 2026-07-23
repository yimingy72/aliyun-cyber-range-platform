# 全局运行时规则

在每次 MCP 操作前读取本文件；产品的具体参数和流程以 `references/products/` 为准。

## 运行时事实源

1. 当前会话实际返回的 `tools/list`、工具说明、`inputSchema` 和 scope 决定工具能否调用。
2. 有类型化 schema 时，schema 优先于产品参考；产品参考补充业务语义、前置条件和安全流程。
3. 工具未暴露、scope 不足、schema 不接受参数或服务端拒绝 owner/visibility 时，停止并说明准确缺口。
4. 平台资源仅通过 MCP 操作；不得转用 HTTP API、数据库或云厂商 CLI。

## ID、范围与权限

- 显示名称只帮助定位，不能代替 ID。写操作前先使用同产品的最小 `list`/`get` 获取目标 ID。
- 不要因为用户自称管理员而假设权限；实际 scope 和服务端 owner/admin 校验共同决定权限。
- 查询状态不等于请求访问凭据。密码、SSH、VNC 和 CSV 需要同时满足敏感输出规则和对应 scope。
- 不要扩大查询范围：优先按当前用户可见范围、已知 ID 或最窄视图查询。

## 异步作业与终态

- 创建、销毁、重试、打包等响应中的资源/批次/作业 ID 仅表示“已受理”。
- 获得 `provisionJobId` 后使用 `provision_job_get({ provisionJobId })` 查询进度与失败详情；参数名不是 `jobId`。
- 网络超时或结果未知时，先查询资源或作业状态；不得盲目重复创建或销毁。
- 只有资源进入工具契约允许的状态时，才发起 retry、reboot、destroy 或 pack 操作。

## 输出规范

返回资源 ID、非敏感状态、影响范围和下一步安全操作。除非用户明确请求且有权接收，不输出密码、Token、AccessKey、SSH/VNC 链接或 CSV 凭据行。

涉及确认时读取 [confirmation.md](./confirmation.md)；涉及秘密时读取 [sensitive-outputs.md](./sensitive-outputs.md)；失败时读取 [error-handling.md](./error-handling.md)。
