# 靶场模板转换约束设计

## 目标

将靶场拓扑设计作为创建模板时唯一可写的事实源。每一条模板创建路径都必须先将拓扑转换并校验为部署规格，再持久化派生产物。

## 范围

- 在 MCP Server 与 API 之间共享“拓扑图转换为模板规格”的转换器。
- 支持一个主 VPC CIDR 与显式声明的多个附加 VPC CIDR。
- 要求每个交换机 CIDR 均归属于某个已配置的 VPC CIDR 块。
- 拒绝调用方在创建模板时直接提交派生拓扑产物。
- 将前端“靶场编排”和“编排实例”页面的实际操作暴露给具备相应 scope 的 MCP 客户端。
- 更新项目 Skill，使其先产出 `RangeDesign/v1` 或完整实例拓扑，再调用经过转换约束的 MCP 工具。

## 数据模型

网络的规范化声明为：

```ts
{
  primaryVpcCidr: string;
  secondaryVpcCidrs: string[];
}
```

为兼容现有模板，`topologySpec.vpcCidr` 继续保存主 CIDR。附加 CIDR 存放于 `scenarioTemplateSpec.topology` 与 `compiledProvisionSpec.topology`，再通过 `secondary_vpc_cidrs` 传递给 OpenTofu 渲染变量。

现有企业靶场 OpenTofu 模块已经会先为 VPC 绑定附加 CIDR，再创建交换机。将其变为显式数据后，便不再依赖模块中默认的 `172.16.0.0/16` 和 `192.168.0.0/16`。

## 转换边界

`compileTemplateTopology` 将迁入 `@aliyun-cyber-range/scenario-runtime`。它接收拓扑图和模板创作元数据，规范化默认值、校验全部图关系，并生成：

- `topologyGraph`
- `topologySpec`
- `scenarioTemplateSpec`
- `compiledProvisionSpec`
- `compiledSpec`

MCP 的 `range_template_create` 只接收拓扑元数据和拓扑图，并在调用 API 前运行相同的转换器。其 schema 不暴露派生字段。MCP 的“检测并保存拓扑”与编排实例的保存、应用、同步也只接收完整拓扑图，并在服务端请求前生成派生规格。

## MCP 编排工具

模板编排能力统一以 `range_template_*` 暴露，并且与页面功能一一对应：

- `templates:read`：`range_template_list`、`range_template_get`。
- `templates:write`：`range_template_create`、`range_template_update`、
  `range_template_clone`、`range_template_topology_detect_and_save`。
- `templates:publish`：`range_template_publish`、`range_template_unpublish`。
- `templates:delete`：`range_template_delete`。

“检测并保存”是编辑器节点、连线、网络策略等本地交互的唯一 MCP 写入边界；不再暴露独立节点、连线、批量变更、预检或校验工具。平台没有单独的共享工具：`range_template_publish` 同时生成可使用的发布版本并设为平台可见，`range_template_unpublish` 隐藏模板但保留其已保存拓扑。

编排实例能力统一以 `range_instance_*` 暴露：

- `ranges:read`：列表、详情；访问入口另需 `instances:credentials:read`。
- `ranges:create`：`range_instance_launch`。
- `ranges:write`：实例拓扑保存；与 `ranges:control` 组合应用变更；与 `templates:write` 组合同步回模板。
- `ranges:control`：失败重试和节点开机、关机、重启、打包镜像。
- `ranges:destroy`：整套实例销毁；`ranges:delete`：删除创建失败记录。

每个工具必须携带标准 MCP 定义：`name`、`title`、`description`、
`inputSchema`、`outputSchema` 和 `annotations`。写操作的注解应标识其
非只读属性；删除、销毁和关机还应标识为破坏性操作。工具发现只返回当前
授权 scope 允许的工具。

## 网络语义

- `primaryVpcCidr` 用于创建 VPC。
- `secondaryVpcCidrs` 用于为该 VPC 创建附加 IPv4 CIDR 块。
- 每个交换机必须属于主 CIDR 或任一附加 CIDR。
- 一个靶场使用一台共享 NAT 网关。
- SNAT 与 DNAT 使用不同的 EIP。每个开启 SNAT 的交换机创建一条 SNAT 规则；DNAT 因共享一个 DNAT EIP，外部端口必须唯一。

## Skill 契约

操作 Skill 要求 Agent：

1. 先产出或接收 `RangeDesign/v1`：其中包含明确的 VPC CIDR 块、交换机、主机、镜像选择器、共享 NAT、ACL、安全组和初始化配置。
2. 使用只读的平台镜像工具解析镜像选择器。
3. 创建模板时只能调用 `range_template_create`；修改模板拓扑时只能调用 `range_template_topology_detect_and_save`。
4. 不得手工编写或传递四份派生产物。

## 测试

- 图中含 `10.0.0.0/24`、`172.16.0.0/24`、`192.168.0.0/24` 三个交换机时，使用匹配的主/附加 VPC CIDR 能成功转换。
- 交换机 CIDR 不属于任何已配置 VPC CIDR 时被拒绝。
- API 创建模板时，调用方提交派生字段会被拒绝。
- MCP 的 `range_template_create` 会转换拓扑图，且无法接收原始派生字段。
- MCP 工具列表测试验证全部编排工具会按 scope 暴露，且每项均含完整标准
  定义与正确的行为注解。
- 渲染器测试验证附加 CIDR 会到达 OpenTofu 的 `secondary_vpc_cidrs` 变量。
