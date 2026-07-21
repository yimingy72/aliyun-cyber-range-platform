# 自定义 OSS 镜像导入存储桶设计

日期：2026-07-21
状态：待规格审阅

## 1. 背景与目标

平台当前会根据阿里云账号和地域生成镜像导入 OSS Bucket，并尝试创建 Bucket、设为私有及写入 CORS。这样将账号凭据是否可用与平台能否管理 Bucket 绑定在一起：即使 STS 身份校验成功，只要 Bucket 创建或配置失败，管理员也无法保存或切换该账号。

本次改为由平台管理员显式提供镜像导入 Bucket 名称。平台只使用管理员已经创建并配置好的 Bucket，绝不自动创建或修改 Bucket。未配置 Bucket 不影响账号保存、切换或其他云资源功能，只会关闭镜像上传。

成功标准：

1. 管理员可在云配置中填写或清空自定义 OSS Bucket 名。
2. 平台不会发起 OSS Bucket 创建、ACL 写入或 CORS 写入请求。
3. 已验证存在且当前凭据可访问的 Bucket 才能用于镜像上传。
4. Bucket 未填写、不存在或不可访问时，阿里云账号仍可以保存、激活和切换；上传镜像不可用。
5. 服务端始终拦截不具备 Bucket 条件的上传请求，不能仅依赖前端禁用。

## 2. 范围与非目标

本次范围包括云配置、云账号上下文、镜像上传 API 及镜像中心的状态展示。

本次不包含：

- 创建、删除、修改 OSS Bucket；
- 修改 Bucket ACL、生命周期、CORS 或其他策略；
- 为管理员自动补全或猜测 Bucket 名；
- 对真实阿里云账号执行写入型验证；
- 改变现有镜像导入、平台镜像资产及实例创建的业务流程。

## 3. 方案选择

采用“账号状态与上传 Bucket 状态解耦”的方案。

| 方案 | 说明 | 结论 |
| --- | --- | --- |
| A：解耦账号与 Bucket（采用） | STS 决定账号是否可用；Bucket 单独记录配置和验证状态。 | 账号切换不再被 Bucket 管理权限阻断，契合自带 Bucket 的运营方式。 |
| B：Bucket 失败即账号不可用 | 维持现有 `degraded` 语义，仅停止自动创建。 | 仍会让镜像功能阻断非镜像功能，不采用。 |
| C：只在前端隐藏上传 | 后端不保存/验证 Bucket 状态。 | 可被直接调用 API 绕过，也无法解释故障原因，不采用。 |

## 4. 数据与状态设计

### 4.1 配置字段

在云配置读写模型中增加可选字段 `imageImportBucket`。它是普通配置值，不属于凭据，前端以“自定义 OSS 存储桶名”呈现；空值表示管理员不开放镜像上传。

该值会先做 Bucket 名格式校验（3–63 位小写字母、数字或连字符，且首尾为字母或数字），再写入现有 `CloudAccountContext.imageImportBucket`。该数据库字段保持非空：未配置时持久化为空字符串，因此本次不需要 Prisma 数据迁移。

### 4.2 两类状态

`CloudAccountContext.status` 只表示阿里云账号上下文是否可用：

- `ready`：STS 身份校验成功，可以作为当前阿里云账号；
- `degraded`：凭据或账号上下文确实不可用；
- 其余现有状态仅保留兼容，不再用于表达 Bucket 故障。

`CloudAccountContext.bucketStatus` 独立表达镜像上传前置条件：

- `unconfigured`：未提供 Bucket 名；
- `ready`：已提供 Bucket，且只读验证成功；
- `unavailable`：提供的 Bucket 不存在、地域不匹配或当前凭据无法访问。

`lastError` 在 `unavailable` 时保存经过脱敏的失败原因，供管理员在配置页查看；不得写入或返回 AccessKey、Secret、签名串和完整 OSS 授权响应。

### 4.3 旧数据兼容

已存在的云账号上下文保留其已保存的 Bucket 名与状态。升级不会创建、修改或删除任何历史 Bucket。管理员下一次保存时，页面会展示已有名称；清空后即明确关闭上传能力。

## 5. 后端行为

### 5.1 保存云配置

`SystemConfigService.updateSnapshot()` 将 Bucket 值传给 `CloudAccountContextsService.saveFromCloudConfig()`。保存顺序如下：

1. 校验地域、可用区、凭据与 Bucket 名格式；
2. 调用 STS `GetCallerIdentity` 验证凭据并解析账号；
3. 创建或更新对应账号/地域上下文，并使账号状态为 `ready`；
4. 按 Bucket 输入更新独立状态：
   - 空值：写入空字符串与 `unconfigured`；
   - 非空值：向目标 Bucket 根路径发起已签名 `HEAD` 验证；成功写入 `ready`，失败写入 `unavailable`；
5. 账号激活只检查账号 `status === ready`，不再要求 Bucket 已就绪。

Bucket 校验仅使用 `HEAD`。它既不创建资源，也不更新 ACL/CORS。`PUT Bucket`、`PUT ?acl`、`PUT ?cors` 以及 CORS 合并逻辑将被移除。

如果更新前的账号上下文有仍需要临时对象的镜像导入任务（未清理的上传、导入或待清理任务），不允许更换或清空该上下文的 Bucket；接口返回冲突提示，要求先完成或清理任务。这样无需改变 `ImageImportJob` 表，也不会让已创建的预签名地址或清理任务指向新的 Bucket。

更换 AccessKey ID 时仍须同时提供完整的新 Secret；掩码值 `********` 只表示沿用同一凭据的既有 Secret，不能与新的 AccessKey ID 组合。

### 5.2 凭据读取与上传保护

`getCredentials()` 的“账号可用”检查只判断 `status === ready`。镜像上传使用独立的 Bucket 前置检查（例如 `requireImageImportBucket`）：要求活跃账号、`bucketStatus === ready` 且 Bucket 名非空。

`ImageImportsService.createUpload()` 在创建任务和生成预签名 PUT URL 前执行该检查。未配置时返回“当前阿里云账号未配置镜像导入 Bucket”；验证失败时返回“配置的镜像导入 Bucket 不可用，请检查名称、地域和权限”。两类失败都不得创建 `ImageImportJob`，也不得生成上传 URL。

完成上传、重试、同步和临时对象清理继续使用与任务关联的账号上下文。前述配置变更保护确保它们仍指向任务创建时的 Bucket。

## 6. 前端体验

### 6.1 云配置面板

在 AccessKey Secret 后增加“自定义 OSS 存储桶名”输入框，标注为可选。帮助文字明确：

> 仅使用已存在的 Bucket。留空将关闭镜像上传；平台不会创建 Bucket 或修改其权限、CORS。

保存结果按账号与 Bucket 分别反馈：账号保存成功时不再承诺“Bucket 已就绪”；若 Bucket 未配置或不可用，显示对应原因和镜像上传关闭状态，而不是把整个云配置保存视为失败。

### 6.2 镜像中心

镜像中心继续获取活跃且账号状态为 `ready` 的上下文，并根据 `imageImportBucket` 与 `bucketStatus` 决定上传能力：

- `ready`：显示并启用“上传镜像”；
- `unconfigured`：禁用上传入口，并提示到云配置填写自定义 OSS Bucket；
- `unavailable`：禁用上传入口，并提示检查 Bucket 是否存在、地域是否一致及凭据权限。

入口保持可见且不可点击，方便管理员理解功能关闭的原因；上传表单和网络请求不会在禁用状态下启动。

### 6.3 Bucket 管理员前置条件

平台不代管 Bucket。管理员需要自行保证：

1. Bucket 已在所选地域创建，且当前凭据可访问；
2. 当前凭据具有镜像临时对象所需的上传、查询和清理权限；
3. Bucket 的 CORS 已允许平台 Web 来源对镜像对象执行 `PUT`；
4. Bucket 的 ACL 与策略符合组织的安全要求（通常为私有）。

保存时的只读 `HEAD` 只能验证 Bucket 存在和当前凭据的访问能力，不能通过写入操作验证浏览器 CORS 或对象上传权限。因此这些条件不满足时，浏览器上传仍会失败，平台将显示原始的安全错误信息摘要，而不擅自修改云端配置。

## 7. 接口与展示契约

云配置快照和 `CloudAccountContext` 返回值包含 `imageImportBucket`、`bucketStatus` 与可选的 `lastError`。前端不会接收 AccessKey Secret。

下列状态矩阵为最终行为：

| STS | Bucket 输入与只读校验 | 账号状态 | Bucket 状态 | 可切换账号 | 可上传镜像 |
| --- | --- | --- | --- | --- | --- |
| 成功 | 空 | `ready` | `unconfigured` | 是 | 否 |
| 成功 | 存在且可访问 | `ready` | `ready` | 是 | 是 |
| 成功 | 不存在或不可访问 | `ready` | `unavailable` | 是 | 否 |
| 失败 | 任意 | 保留失败并拒绝本次保存 | 不更新为可用 | 否（该次配置） | 否 |

## 8. 测试与验证

先为以下行为补充失败测试，再实施：

1. 云账号服务：空 Bucket 保存为账号 `ready` / Bucket `unconfigured`，且不会调用任何 OSS 写请求；
2. 云账号服务：存在 Bucket 的 `HEAD` 成功后为 `ready`；404、403 和网络失败仅使 Bucket `unavailable`，不使账号降级；
3. 云账号服务：激活不再因未配置或不可用 Bucket 被拒绝；存在未清理镜像任务时拒绝更换/清空 Bucket；
4. 镜像导入服务：Bucket 未配置或不可用时拒绝创建上传任务和预签名 URL；
5. API 配置读写：新字段能够保存、返回，Secret 掩码规则保持不变；
6. Web：配置面板传递并解释 Bucket 输入；镜像中心在三种 `bucketStatus` 下正确启用或禁用入口；
7. 回归：已有已验证 Bucket 仍可进入现有上传、导入、同步与清理链路。

验证只使用 mock/容器化测试，不调用真实阿里云 API。实施后依次构建相关 Docker 镜像、在 Docker 容器内执行定向 API/Web 测试，重新启动 Compose 栈并检查 API、Web 和 MCP 健康端点。

## 9. 安全边界

平台对 OSS 的配置期操作仅限签名的只读 `HEAD`，不创建或持久化额外云资源。运行期镜像上传仍按既有设计由浏览器使用短期预签名 URL 直传，服务端会在发放该 URL 前完成状态授权。日志、错误、接口返回和文档不得输出明文 AccessKey、Secret、Token 或预签名 URL。
