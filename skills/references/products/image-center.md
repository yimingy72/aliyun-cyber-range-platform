# 镜像中心

管理可供独立靶机和靶场拓扑使用的平台镜像资产。进入本产品前先读取 [全局运行时规则](../global-reference.md)；所有镜像写操作都必须读取 [危险操作确认](../confirmation.md) 并完成用户确认及服务端要求的二阶段确认。

## 工具与权限

| 操作 | MCP 工具 | Scope | 要点 |
|---|---|---|---|
| 查询镜像 | `platform_image_list` | `images:read` | `view` 为 `platform` 或 `mine`，默认平台视图。 |
| 收录云快照 | `platform_image_collect` | `images:write` | 需要准确 `snapshotId` 和 `displayName`。 |
| 重命名 | `platform_image_rename` | `images:write` | 需要 `platformImageAssetId` 与新名称。 |
| 启用 / 停用 | `platform_image_enable` / `platform_image_disable` | `images:write` | 停用会阻止后续新建使用该镜像。 |
| 平台发布 / 取消发布 | `platform_image_publish` / `platform_image_unpublish` | `images:write` | 改变镜像可见性。 |
| 删除 | `platform_image_remove` | `images:write` | 永久删除平台镜像资产。 |

## 产品内意图路由

| 用户意图 | 工具与流程 | 参数约束 |
|---|---|---|
| “可用镜像、我的镜像、选镜像” | `platform_image_list` | `view` 只接受 `platform` 或 `mine`；查询不需要写入授权。 |
| “把快照纳入平台” | [收录快照](#收录快照) | 必须有精确 `snapshotId` 和非空 `displayName`；属于危险操作。 |
| “改名称、启用、停用” | [资产属性与可用性](#资产属性与可用性) | 使用准确 `platformImageAssetId`；所有写入均为危险操作。 |
| “发布、取消发布、删除镜像” | [可见性与删除](#可见性与删除) | 使用准确 `platformImageAssetId`，属于危险操作。 |
| “从单实例生成镜像” | 转到 [实例管理](./instance-management.md) 的打包 | 不是收录已有云快照。 |

## 功能流程与参数约束

### 查询或选择镜像

1. 调用 `platform_image_list`，按调用者可见范围定位镜像资产。独立靶机使用资产 `id`（`platformImageAssetId`）；拓扑转换则要解析该资产的云镜像 `imageId`。
2. 创建独立靶机前，确认镜像已启用且对调用者可消费。
3. 靶场上游若只给出业务镜像名，必须精确匹配一个可见资产；重名或无匹配时停止请求选择。将该资产的 `imageId`（阿里云 `m-...`）填入 topology graph 的 ECS `image`，不可用显示名称或资产 `id` 代替。
4. 不要根据显示名称猜测 `platformImageAssetId` 或云镜像 ID。

### 收录快照

1. 向用户取得准确云 `snapshotId` 与显示名称；平台当前没有列出云快照的 MCP 工具。
2. 说明这会创建平台可管理的镜像资产，取得用户确认后调用 `platform_image_collect`；若服务端要求确认，按二阶段流程完成。
3. 收录成功后用 `platform_image_list` 核对新资产；需要用于独立靶机时确认启用状态。

### 资产属性与可用性

- 重命名使用 `platform_image_rename({ platformImageAssetId, displayName })`；显示名称不能替代 ID。重命名前须确认。
- 启用/停用只传 `platformImageAssetId`。停用会阻止后续独立靶机使用该资产，不会销毁已有实例或删除镜像；启用和停用都须确认。

### 可见性与删除

- `publish`/`unpublish` 管理平台可见性；`enable`/`disable` 管理是否允许用于新建；两者不可混用。
- 对收录、重命名、启用、停用、发布、取消发布和删除，均先展示镜像/快照准确 ID、当前状态与影响范围并取得确认。
- 删除前确认没有要保留的使用计划；失败时不要改用其它接口强删。

由已有独立靶机生成私有镜像属于 [实例管理](./instance-management.md) 的 `single_instance_pack_image`，不是收录快照。
