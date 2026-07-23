# 靶场编排

管理综合靶场模板及其完整拓扑。模板要么已保存未发布，要么已发布到平台；发布与取消发布是唯一的可见性操作。

## MCP 工具与参数

创建或替换模板拓扑必须先经过本文件的“设计转换流程”。转换 Skill 只能传完整 `topologyGraph` 与下表接受的元数据，绝不能传 `topologySpec`、`scenarioTemplateSpec`、`compiledProvisionSpec` 或 `compiledSpec`。

除非行内说明，写工具可按运行时 schema 接收 `idempotencyKey` 和 `confirmationId`。

| 操作 | MCP 工具 | 必填参数 | 可选参数 | Scope |
|---|---|---|---|---|
| 查看模板列表 | `range_template_list` | — | `view: platform\|mine`，默认 `platform` | `templates:read` |
| 查看模板详情 | `range_template_get` | `templateId` | — | `templates:read` |
| 新建模板 | `range_template_create` | `name`、完整 `topologyGraph` | `description`、`primaryVpcCidr`、`secondaryVpcCidrs`、已废弃别名 `vpcCidr`、`defaultRegion`、`defaultZoneId`、`publicEntryProtocols`、`variableSchema`、`outputSchema`、`defaultNetworkPolicy`、操作元数据 | `templates:write` |
| 编辑信息 | `range_template_update` | `templateId`、`updates`（至少一个 `name` 或 `description`） | 操作元数据 | `templates:write` |
| 复制模板 | `range_template_clone` | `templateId` | 操作元数据 | `templates:write` |
| 检测并保存 | `range_template_topology_detect_and_save` | `templateId`、完整 `topologyGraph` | `primaryVpcCidr`、`secondaryVpcCidrs`、`vpcCidr`、`defaultRegion`、`defaultZoneId`、`publicEntryProtocols`、操作元数据 | `templates:write` |
| 发布到平台 | `range_template_publish` | `templateId` | 操作元数据 | `templates:publish` |
| 取消发布 | `range_template_unpublish` | `templateId` | 操作元数据 | `templates:publish` |
| 删除模板 | `range_template_delete` | `templateId` | 操作元数据 | `templates:delete` |

`range_template_topology_detect_and_save` 会编译并校验完整图后保存，但不会发布。拓扑修改始终重新生成完整图；没有“共享/取消共享”、独立预检或节点补丁工具。

创建时平台会生成 `slug`、版本、云厂商、IaC 类型和模块路径。它们不是 `RangeDesign/v1` 输出字段，也不是 `range_template_create` 参数；调用方传入会被 MCP 拒绝。

## 设计转换流程

创建或修改模板拓扑必须经过：

```text
靶场设计 Skill -> RangeDesign/v1 -> 靶场拓扑转换 Skill -> 靶场编排 MCP 工具
```

1. **严格解析**：先验证输入是一份完整、无截断的 `RangeDesign/v1` YAML。`connections` 使用对象数组，所有 ACL、DNAT 和安全组字段完整；解析失败时不得调用任何 MCP 工具。
2. **靶场设计 Skill** 输出本文件定义的完整 `RangeDesign/v1`。
3. **靶场拓扑转换 Skill** 查询当前调用者可见的镜像，解析精确 `imageId`，补齐平台默认值，输出完整 `topologyGraph`。
4. **MCP 工具** 重新编译与校验完整图，自动生成内部派生规格后调用平台 API。

缺少镜像、IP、CIDR、连线、入口主机或 NAT 参数时，转换 Skill 必须返回缺项给设计 Skill，不得猜测。

## RangeDesign/v1 固定输出

设计 Skill 必须输出全部必填字段和全部数组；没有内容时使用空数组。可选标量字段仅在有明确业务含义时输出。

```yaml
schemaVersion: RangeDesign/v1

template:
  name: "<模板名称>"
  description: "<用途、验证目标与安全边界>"
  defaultRegion: "<由转换 Skill 通过 cloud_config_get 解析>"
  defaultZoneId: "<由转换 Skill 通过 cloud_config_get 解析>"
  publicEntryProtocols:
    - protocol: tcp
      port: 80

vpc:
  primaryVpcCidr: 10.0.0.0/16
  secondaryVpcCidrs: []
  sharedNat:
    natGatewayKey: nat-gw-shared-1
    snatEipKey: eip-snat-shared-1
    dnatEipKey: eip-dnat-public-1

router:
  key: router-egress-1
  label: "出口路由器"
  routeRole: egress
  egressType: internet
  bindEip: false

switches:
  - key: sw-dmz
    label: "DMZ 交换机"
    zoneKey: zone-main
    cidr: 10.0.10.0/24
    purpose: dmz
    snatEnabled: true
    aclRules:
      - key: dmz-in-http
        direction: inbound
        protocol: tcp
        portRange: "80/80"
        sourceCidr: 0.0.0.0/0
        policy: allow
        priority: 10
        description: "允许公网 HTTP"
    dnatMappings:
      - key: dnat-web-80
        targetEcsKey: ecs-web
        externalPort: 80
        internalPort: 80
        protocol: tcp
        description: "公网 80 转发到 Web ECS"

ecs:
  - key: ecs-web
    label: "Web ECS"
    role: public-web
    zoneKey: zone-main
    cpu: 2
    memoryGiB: 4
    imageSelector:
      displayName: "<可见且启用的平台镜像精确显示名称>"
      match: exact-enabled-platform-image
    privateIp: 10.0.10.10
    exposePublic: true
    initScript: ""
    portGroups: []
    nics:
      - key: nic-web-1
        switchKey: sw-dmz
        zoneKey: zone-main
        privateIp: 10.0.10.10
        secondaryIps: []
        securityGroupRulesMode: custom
        securityGroupRules:
          - key: sg-web-http
            direction: ingress
            protocol: tcp
            portRange: "80/80"
            sourceCidr: 0.0.0.0/0
            policy: accept
            priority: 10
            description: "允许 HTTP"

connections:
  - key: edge-router-dmz
    from: router-egress-1
    to: sw-dmz
  - key: edge-dmz-web
    from: sw-dmz
    to: ecs-web
```

`defaultRegion`、`defaultZoneId` 可以在设计阶段保留“由转换 Skill 读取”的占位文字；转换 Skill 必须调用 `cloud_config_get` 替换它们，未解析占位文字不得调用 MCP 写工具。

### 设计字段与约束

| 部分 | 必须表达的事实 | 约束 |
|---|---|---|
| `template` | 名称、描述、默认地域/可用区和入口协议 | 入口协议覆盖每个 DNAT 协议和外部端口；`slug`、版本、云厂商、IaC 与模块路径由平台生成，不得输出或传给 MCP。 |
| `vpc` | 一个主 CIDR、零到四个附加 CIDR、一个共享 NAT 逻辑标识 | 一个 VPC 可使用不连续 CIDR；所有 CIDR 不重叠。SNAT 与 DNAT 使用同一 NAT 网关、不同 EIP。 |
| `router` | 唯一路由器的键、名称和出口意图 | 每份设计恰好一个 Router。 |
| `switches` | 交换机 CIDR、可用区、用途、ACL、SNAT、DNAT | CIDR 必须落在主或附加 VPC CIDR 内且互不重叠；`aclRules`、`dnatMappings` 始终存在，可为空数组。 |
| `ecs` | 计算规格、角色、镜像选择、主 IP、初始化需求、所有 NIC 和安全组 | 每台 ECS 至少一个 NIC；ECS `privateIp` 等于第一个 NIC 的 `privateIp`。 |
| `nics` | NIC 键、所属交换机、IP、辅助 IP 与安全组 | 每张 NIC 都有对应 `switch -> ecs` 连接。自定义规则时显式 `securityGroupRulesMode: custom`。 |
| `connections` | Router 到每个 Switch、Switch 到每台 ECS 的完整连线 | 使用 `{ key, from, to }`；键、来源和目标必须唯一且可解析。 |

1. 交换机 CIDR、ECS 主/辅助 IP 必须属于对应 VPC 或交换机；IP 不可重复，不能使用网络或广播地址。
2. 开启 `snatEnabled` 的交换机共用 `vpc.sharedNat.natGatewayKey` 和 `snatEipKey`。DNAT 使用 `dnatEipKey`，绝不能与 SNAT EIP 相同。
3. `externalPort + protocol` 在同一 VPC 内全局唯一；DNAT 目标必须是存在的 ECS 且 `exposePublic: true`。
4. ACL 必须给出方向、协议、端口范围、来源 CIDR、策略与优先级，策略只能是 `allow` 或 `drop`。
5. 安全组规则必须给出方向、协议、端口范围、来源 CIDR、策略与优先级，策略只能是 `accept` 或 `drop`。
6. 设计中只能有一个公网入口 ECS。它应有至少一个 DNAT 映射；没有公网入口时所有 ECS 必须 `exposePublic: false` 且 DNAT 为空。
7. 不输出 `customPassword`，除非用户明确要求设置该 ECS 的初始密码。

## 转换 Skill 输出与校验

转换 Skill 必须按顺序：

1. 验证 `RangeDesign/v1` YAML 的语法、字段、数组和连接对象；失败时返回具体路径，不得调用 MCP。
2. 调用 `cloud_config_get` 解析并校验默认地域、可用区。
3. 调用 `platform_image_list`，将每个 `imageSelector.displayName` 精确解析为唯一、已启用的 `platformImageAssetId` 和阿里云 `imageId`；无匹配、重名或停用时停止。
4. 校验 VPC、CIDR、IP、NAT、ACL、安全组、连线和公网入口；缺项或歧义返回给设计 Skill。
5. 输出 `schemaVersion: "2.0.0"` 的完整 `topologyGraph`，Router、Switch、ECS、NIC 和边的 ID 使用设计 `key`，边使用 `relationType: "manual"`。
6. ECS 节点写入精确 `image`、`platformImageAssetId`、`imageStrategy: { mode: fixed, imageId }`、`instanceTypeStrategy: { mode: auto }`、`networkInterfaces`、`dnatMappings`、`portGroups` 与 `initScript`。
7. Switch 节点写入 `nat: { snatEnabled, dnatMappings }` 与完整 ACL。共享 NAT/EIP 实际资源由 MCP 编译器派生，不能提交派生规格。

调用 `range_template_create` 时只传 `name`、可选 `description`、可选网络元数据和完整 `topologyGraph`。不要传任何平台生成或编译派生字段。

最小结果形状：

```ts
{
  schemaVersion: '2.0.0',
  nodes: [
    { id: 'router-egress-1', kind: 'router', label: '出口路由器', ... },
    { id: 'sw-dmz', kind: 'switch', label: 'DMZ 交换机', zoneKey: 'zone-main', cidr: '10.0.10.0/24', ... },
    { id: 'ecs-web', kind: 'ecs', label: 'Web ECS', image: 'm-...', platformImageAssetId: '...', nics: [...], ... },
  ],
  edges: [
    { id: 'edge-router-dmz', fromNodeId: 'router-egress-1', toNodeId: 'sw-dmz', relationType: 'manual' },
    { id: 'edge-dmz-web', fromNodeId: 'sw-dmz', toNodeId: 'ecs-web', relationType: 'manual' },
  ],
}
```

## 模板操作

1. 首次创建：由转换 Skill 输出完整图，调用 `range_template_create`。
2. 编辑拓扑：从完整修改结果重新生成图，调用 `range_template_topology_detect_and_save`。
3. 用户明确要求开放给其他用户时，确认模板 ID 和影响范围后调用 `range_template_publish`。
4. 用户明确要求隐藏模板时，调用 `range_template_unpublish`；它不删除模板及已保存拓扑。

发布、取消发布和删除需要入口规定的危险操作确认。发布不会创建一套靶场；实际创建云资源应进入 [编排实例](./range-instances.md)。
