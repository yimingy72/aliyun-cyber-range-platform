# 靶场编排

设计、转换、编辑、检测、发布和共享综合靶场模板。本产品是“设计靶场”与平台 MCP 之间的适配层：上游 Skill 负责给出完整靶场方案；本 Skill 将其转换为可部署的 `topologyGraph`，执行校验，再调用模板工具。MCP 从通过校验的图自动生成 `topologySpec`、`scenarioTemplateSpec` 与 `compiledProvisionSpec`。

不要要求查询、克隆或仅改元数据的请求提供完整拓扑；只有创建、替换或变更拓扑时才进入设计交接和完整图校验。

## 工具与权限

| 操作 | MCP 工具 | Scope |
|---|---|---|
| 查询模板 | `range_template_list`、`range_template_get` | `templates:read` |
| 创建/更新/克隆草稿 | `range_template_create`、`range_template_update`、`range_template_clone` | `templates:write` |
| 预检/校验 | `range_template_topology_detect`、`range_template_validate` | `templates:write` |
| 编辑节点和边 | `range_template_node_*`、`range_template_edge_*`、`range_template_changeset_apply` | `templates:write` |
| 发布与共享 | `range_template_publish`、`range_template_unpublish`、`range_template_share`、`range_template_unshare` | `templates:publish` |
| 删除 | `range_template_delete` | `templates:delete` |

## 编排域内意图路由

| 用户意图 | 进入的功能 | 不应附加的要求 |
|---|---|---|
| “查模板、我的草稿、平台模板、查看拓扑” | [查询模板](#查询模板) | 不要求完整图或写入权限。 |
| “根据已设计好的靶场创建模板” | [设计结果转换与创建拓扑](#设计结果转换与创建拓扑) | 不把设计文本直接当作 MCP 参数。 |
| “复制模板”“只改名称、版本、描述或默认地域” | [克隆、元数据更新与整图替换](#克隆元数据更新与整图替换) | 仅元数据修改不要求图校验。 |
| “替换整个拓扑” | [克隆、元数据更新与整图替换](#克隆元数据更新与整图替换) | 不回写 MCP 生成的编译字段。 |
| “添加/删除/修改节点、网卡、连线、NAT” | [节点、连线与原子变更](#节点连线与原子变更) | 不逐步保存会造成非法中间态的变更。 |
| “检测设计是否能部署”“检查草稿能否发布” | [预检与已保存草稿校验](#预检与已保存草稿校验) | `detect` 不保存，`validate` 不替代创建前预检。 |
| “发布、共享、取消发布、删除模板” | [发布、共享与删除](#发布共享与删除) | 不把模板发布等同于启动一套靶场。 |

“基于模板启动整套环境”属于 [编排实例](./range-instances.md)，不是本产品。

## 设计结果转换与创建拓扑

### 上游设计交接格式

只有在上游 Skill 已完成靶场设计后才进入本流程。它的结果至少需要包含以下语义配置；可以是结构化对象或能无歧义转换为该对象的内容，但缺项时必须返回给上游补全，不能臆测。

| 设计结果部分 | 至少需要的内容 | 转换为 MCP 参数 |
|---|---|---|
| 模板 | `name`、`slug`、`version`、`iacType`、`modulePathOrRef`；可选描述、VPC、地域/可用区、入口协议 | 创建元数据；`cloudProvider` 固定为 `alibaba_cloud`。 |
| Router | 唯一逻辑键和显示名称 | `kind: router` 节点；代表唯一 VPC，作为每个交换机的网络根。 |
| 交换机 | 唯一键、名称、`zoneKey`、CIDR、用途；可选 ACL、SNAT、DNAT | `kind: switch` 节点及其 `nat`/ACL 配置。 |
| ECS | 唯一键、名称、`zoneKey`、角色、业务镜像名称、主私网 IP、入口标记、NIC 列表 | 先将镜像名精确解析为一个可见平台资产的 `imageId`（阿里云 `m-...`），再写入 `kind: ecs` 节点的 `image`；首张 NIC 的 IP 必须等于 ECS 主 IP。 |
| NIC | 唯一键、所属交换机键、主/辅助私网 IP、可选安全组规则 | ECS 的 `nics[]`；每张 NIC 都对应一条交换机到 ECS 的边。 |
| 连通关系 | Router 到每个交换机、交换机到每个 ECS 的实际连接 | `relationType: manual` 的 `router → switch`、`switch → ecs` 边。 |
| NAT/DNAT | 所属交换机、目标 ECS、外部/内部端口、`tcp` 或 `udp` | 交换机 `nat.dnatMappings[]`；目标必须确实连接该交换机。 |

转换产物固定为 `{ schemaVersion: '2.0.0', nodes, edges }`。以设计结果中的稳定逻辑键生成图的 `id`、NIC `id` 和边 `id`；同一设计不可生成相互冲突的 ID。对每个 ECS，先用 `platform_image_list` 在调用者可见范围内精确匹配上游业务镜像名；只有唯一匹配时才取资产的 `imageId`（`m-...`）放入 `image`。重名、无匹配或缺少 `imageId` 时停止并请求上游或用户消歧，不猜测。MCP 会自动生成 `imageStrategy: { mode: 'fixed', imageId: image }`，上游设计 Skill 不需要理解该内部字段。

### 平台转换默认值

上游设计不必携带运行器内部字段。转换层在保留上游显式值的前提下，补齐以下默认值后再调用检测或创建：

- ECS：`initScript: ''`、`dnatMappings: []`、`networkInterfaces: []`、`portGroups: []`、`instanceTypeStrategy: { mode: 'auto' }`；`imageStrategy` 按上节由 `image` 自动生成。
- 每个 NIC：未提供 `secondaryIps` 或 `securityGroupRules` 时，分别传 `[]`。
- Switch：`aclRules: []`、`nat: { snatEnabled: false, dnatMappings: [] }`。
- Router：`routeRole: 'vpc'`、`egressType: 'none'`、`bindEip: false`。

空的 `securityGroupRules` 不代表关闭平台默认规则：企业靶场 OpenTofu 模块会回退为入站 TCP `22` 与 `80`。若上游设计显式给出规则，则原样传入。`publicEntryProtocols` 是模板顶层入口元数据（默认 SSH 22、HTTP 80），不是 ECS 安全组规则，也不会在节点编辑时被重置。

### 调用前参数校验

在调用 `range_template_topology_detect` 前按以下顺序检查；这是对上游设计结果的转换校验，不替代 MCP 的最终二次校验。

1. **完整性与映射**：模板必填元数据、恰好一个 Router、至少一个交换机、至少一个 ECS、每个 ECS 的唯一解析镜像和 NIC 都存在；键、节点 ID、NIC ID、边 ID 唯一，引用均可解析。
2. **网络语义**：`vpcCidr` 是 IPv4 CIDR（未指定时按平台的 `10.0.0.0/16` 默认值）；交换机 CIDR 位于 VPC 内且互不重叠；IP 位于所属交换机网段、不可重复、不可使用网络/广播地址。
3. **节点与连线一致性**：仅构造 `router → switch` 和 `switch → ecs` 的 `manual` 边；唯一 Router 必须连到每个 Switch，每张 NIC 都必须有对应的交换机到 ECS 边，首张 NIC 的交换机 `zoneKey` 与 ECS 一致。MCP 服务端会强制此约束，Skill 检查只是前置反馈。
4. **部署入口与网络策略**：必须且只能有一个入口 ECS（`exposePublic: true` 或 `role: entry`）；DNAT 的目标、端口和协议合法；入口协议若显式提供，端口为 1–65535 且协议非空。
5. **敏感和派生字段**：仅在用户明确提供时传 `customPassword`，并符合阿里云 ECS 密码策略；不传 `topologySpec`、`scenarioTemplateSpec`、`compiledProvisionSpec` 或旧 `compiledSpec`。

### 创建拓扑推荐流程

1. 接收完整的靶场设计结果；对每个业务镜像名称使用 `platform_image_list` 精确解析唯一资产的 `imageId`（`m-...`）。
2. 进行上述转换校验，生成唯一且完整的 `topologyGraph`；校验失败时按字段将缺口返回给上游设计 Skill。
3. 用相同元数据和图调用 `range_template_topology_detect`，在内存中编译与预检，不写入平台。
4. 预检通过后，调用 `range_template_create`，传入 `name`、`slug`、`version`、`cloudProvider: alibaba_cloud`、`iacType`、`modulePathOrRef` 和完整图；只传用户或设计结果明确给出的可选元数据。
5. 创建成功后调用 `range_template_validate` 验证保存的草稿；只有用户明确要求时才进入发布或分享。

`detect` 失败时不得跳过它直接创建，也不要为“修复”而猜测 IP、镜像、入口主机或密码。响应不会回显密码。

## 查询模板

- 查询平台模板用 `range_template_list({ view: 'platform' })`；查询自己可编辑的草稿用 `view: 'mine'`。省略时平台视图是默认值。
- 读取详情用 `range_template_get({ templateId })`。先通过列表获取准确 ID；详情可能包含拓扑，但 `customPassword` 等密码字段已被脱敏，不能据此读取或覆盖凭据。
- 查询只需要 `templates:read`，不触发图校验、确认或写入。若用户的后续动作是基于模板创建环境，转到编排实例而非在这里复制图。

## 克隆、元数据更新与整图替换

### 克隆

`range_template_clone({ templateId })` 将可读取模板复制为新的私有草稿。先读取并确认源模板可见；克隆不是发布，也不需要重新提供完整图。后续若要改变拓扑，再进入相应的编辑或替换流程。

### 仅更新元数据

`range_template_update({ templateId, updates })` 的 `updates` 只包含要改变的字段，例如名称、版本、描述、默认地域或可选 schema 元数据。仅元数据更新不读取或校验完整图；不得以读取结果中的脱敏密码填充写入请求。

### 整图替换

当上游设计重新产出完整拓扑时，在 `updates.topologyGraph` 传入完整新图，并随同必要的 VPC/入口协议元数据。先执行“设计结果转换与创建拓扑”的校验和 `topology_detect`，再更新。MCP 会重新编译派生字段；调用者不得传这些字段。节点/边编辑会从当前模板保留 `vpcCidr`、默认地域/可用区及 `publicEntryProtocols`，除非此次请求显式更新它们。

整图更新中，同 ID ECS 未显式给出 `customPassword` 时，MCP 保留现有密码；只有显式 `customPassword: ''` 才清空并改用平台随机密码。

## 节点、连线与原子变更

对已保存草稿的小范围编辑，先 `range_template_get` 定位模板和当前图，再按变更是否能保持每一步合法选择工具。

| 变更 | 工具与关键参数 | 参数约束与流程 |
|---|---|---|
| 添加节点 | `range_template_node_add({ templateId, node })` | 节点须满足该类型业务字段；MCP 会补运行时默认值。新增 ECS 及其 NIC 时，同时添加对应连线；新增 Switch 必须有 Router 连线；不能单步合法则用 changeset。 |
| 修改节点 | `range_template_node_update({ templateId, nodeId, patch })` | `patch` 至少一个字段，不能修改节点 ID 或类型。修改 NIC、IP、交换机归属或入口属性后必须满足完整图约束。 |
| 删除节点 | `range_template_node_remove({ templateId, nodeId })` | 删除交换机会清理引用它的 NIC；删除 ECS 会清理指向它的 DNAT；若结果不完整，保存被拒绝。 |
| 添加连线 | `range_template_edge_add({ templateId, edge })` | 仅允许合法方向的 `manual` 边。添加 `switch → ecs` 前，目标 ECS 必须已有 `nics[].switchId` 指向该交换机。 |
| 删除连线 | `range_template_edge_remove({ templateId, edgeId })` | 删除 `switch → ecs` 边会同步移除对应 NIC；迁移网络时不能只删旧边。 |
| 多步网络迁移/批量编辑 | `range_template_changeset_apply({ templateId, changes, ... })` | 按顺序在内存中应用，最终编译通过才保存。用于“加替代 NIC/边、删旧 NIC/边”等中间态必然非法的操作。 |

节点、边和 changeset 工具在保存前都会重新编译完整图；前端检测和单次工具成功都不应被当成绕过最终校验的手段。

## 预检与已保存草稿校验

| 目的 | 工具与参数 | 使用时机 |
|---|---|---|
| 检查尚未保存的设计结果 | `range_template_topology_detect({ topologyGraph, ...metadata })` | 上游设计已转换完成、创建或整图替换前；不写入。 |
| 检查已保存草稿 | `range_template_topology_detect({ templateId })` | 希望快速在内存中复核当前草稿；不写入。 |
| 按平台发布前规则校验草稿 | `range_template_validate({ templateId })` | 创建、图编辑或整图替换保存后，以及发布前；不改变草稿。 |

`detect` 负责编译和完整图约束，`validate` 负责平台已保存草稿的发布前检查；二者都通过不等于已发布。

## 发布、共享与删除

- `range_template_publish` / `range_template_unpublish` 改变模板发布状态；`range_template_share` / `range_template_unshare` 改变平台共享可见性；均需要 `templates:publish`。
- `range_template_delete` 需要 `templates:delete`，且活动编排实例仍引用模板时会被平台阻止。
- 这些操作是危险操作：先展示模板 ID、当前状态、可见性和影响范围，获得用户确认；服务端返回 `CONFIRMATION_REQUIRED` 后再按 [confirmation.md](../confirmation.md) 使用相同业务参数、`confirmationId` 和需要时的幂等键完成二阶段调用。
