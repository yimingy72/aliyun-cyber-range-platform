# 靶场编排

本产品严格对应前端“靶场编排”页面。页面对用户呈现的状态只有两类：

- **已保存未发布**：模板和拓扑已保存，创建者仍可编辑，其他用户不可在平台模板列表中使用。
- **已发布到平台**：模板对其他用户可见且可用于生成编排实例。

“版本”“草稿”“编译规格”是后端实现细节，不得把它们作为用户操作、MCP 工具名或对外流程步骤。平台没有单独的“共享/取消共享”功能；“发布到平台/取消发布”就是唯一的可见性操作。

## 设计转换 Skill

创建或修改拓扑必须经过以下链路：

```text
靶场设计 Skill -> 靶场拓扑转换 Skill -> 靶场编排 MCP 工具
```

1. **靶场设计 Skill** 输出完整 `RangeDesign/v1`：模板元数据、VPC、交换机、ECS、镜像选择器、NIC、ACL、安全组、共享 NAT、SNAT、DNAT 与初始化要求。
2. **靶场拓扑转换 Skill** 查询可见镜像并精确解析 `imageId`，补齐平台默认值，输出完整 `topologyGraph`。
3. **MCP 工具** 对完整图再次编译与校验，自动生成 `topologySpec`、`scenarioTemplateSpec` 和 `compiledProvisionSpec` 后再调用平台 API。

转换 Skill 不得手工构造或传递上述三份派生规格。缺镜像、IP、CIDR、连线、入口主机或 NAT 参数时，应将缺项返回给设计 Skill，不得猜测。

## 页面功能与 MCP 工具

| 前端功能 | MCP 工具 | Scope | 说明 |
|---|---|---|---|
| 查看模板列表 | `range_template_list` | `templates:read` | `view=mine` 是自己的可编辑模板，`view=platform` 是已发布到平台的模板。 |
| 查看模板详情 | `range_template_get` | `templates:read` | 返回拓扑但脱敏密码。 |
| 新建模板 | `range_template_create` | `templates:write` | 必须传转换 Skill 产出的完整图。 |
| 编辑信息 | `range_template_update` | `templates:write` | 只更新前端实际提供的名称、描述，不接收拓扑或编译字段。 |
| 复制模板 | `range_template_clone` | `templates:write` | 产生一份已保存未发布的可编辑模板。 |
| 检测并保存 | `range_template_topology_detect_and_save` | `templates:write` | 对应编辑器“检测并保存”；完整图通过编译和发布前校验后才保存，不会发布。 |
| 发布到平台 | `range_template_publish` | `templates:publish` | 生成可使用的发布结果并使模板对其他用户可见。 |
| 取消发布 | `range_template_unpublish` | `templates:publish` | 从平台列表隐藏模板，保留模板和已保存拓扑。 |
| 删除模板 | `range_template_delete` | `templates:delete` | 活动编排实例仍引用时会被拒绝。 |

MCP 不暴露“共享/取消共享”、独立“预检”、独立“校验”、节点增删改、连线增删或批量变更。它们是前端编辑器内部交互；Agent 修改拓扑时应由转换 Skill 输出完整图，再调用“检测并保存”。

## 转换 Skill 输入

`RangeDesign/v1` 至少包含：

| 设计部分 | 必填内容 | 转换结果 |
|---|---|---|
| 模板 | `name`、`slug`、`version`、`iacType`、`modulePathOrRef` | 创建参数；`cloudProvider` 固定为 `alibaba_cloud`。 |
| VPC | `primaryVpcCidr`，可选 `secondaryVpcCidrs` | 同一 VPC 的主/附加 IPv4 CIDR。 |
| Router | 唯一逻辑键、名称 | 一个 `router` 节点。 |
| 交换机 | 键、名称、`zoneKey`、CIDR、用途、ACL、SNAT、DNAT | `switch` 节点。交换机 CIDR 必须属于主 CIDR 或任一附加 CIDR。 |
| ECS | 键、名称、角色、`zoneKey`、私网 IP、镜像名称、入口标记 | 精确解析的 `imageId` 写入 `ecs.image`。 |
| NIC | 键、所属交换机、主/辅助 IP、安全组规则 | ECS `nics[]` 与对应 `switch -> ecs` 连线。 |
| 连接 | Router 到每个交换机、交换机到每个 ECS | `manual` 边。 |
| NAT | 一个共享 NAT 网关、独立 SNAT EIP、独立 DNAT EIP | SNAT 按交换机规则生成，DNAT 写在目标交换机。 |

一个 VPC 可以拥有多个不连续 CIDR，例如 `10.0.0.0/16`、`172.16.0.0/16`、`192.168.0.0/16`。SNAT 在同一 VPC 内共享 NAT 网关和 SNAT EIP；DNAT 使用另一张独立 EIP，DNAT 外部端口全局不可重复。

## 转换 Skill 输出与校验

输出固定为：

```ts
{
  schemaVersion: '2.0.0',
  nodes: [...],
  edges: [...]
}
```

转换前至少校验：

1. 恰好一个 Router，至少一个交换机与 ECS；节点、NIC、边和逻辑键均唯一。
2. 每个交换机 CIDR 位于 VPC 的主或附加 CIDR 内，所有交换机 CIDR 不重叠。
3. 每个私网 IP 位于所属交换机 CIDR 内，IP 不重复且不是网络或广播地址。
4. 每个交换机都有 `router -> switch` 边；每张 NIC 都有对应 `switch -> ecs` 边。
5. 必须且只能有一个入口 ECS；DNAT 目标与端口合法，SNAT/DNAT 不使用同一 EIP。
6. 业务镜像名称必须唯一解析为当前调用者可见的 `imageId`。无匹配、重名或不可用时停止。

平台默认值由转换 Skill 补齐：Router 的 VPC 路由属性、Switch 的空 ACL/NAT、ECS 的初始化脚本/端口组/策略、NIC 的空辅助 IP 与安全组规则。除非用户明确提供，不能填充 `customPassword`。

## 推荐流程

1. 先用镜像查询工具解析每个业务镜像。
2. 由转换 Skill 生成完整 `topologyGraph` 并做前置校验。
3. 首次创建调用 `range_template_create`。
4. 在编辑器中发生拓扑调整后，由转换 Skill 从完整修改结果重新生成图，调用 `range_template_topology_detect_and_save`。
5. 用户明确要求开放给其他用户时，确认模板 ID、影响范围后调用 `range_template_publish`。
6. 用户明确要求隐藏模板时，调用 `range_template_unpublish`；它不删除模板。

发布、取消发布和删除需要用户确认。发布不会创建一套靶场；基于模板实际创建云资源应进入 [编排实例](./range-instances.md)。
