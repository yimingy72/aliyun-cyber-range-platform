# 靶场编排

管理综合靶场模板及其完整拓扑。模板要么为私有已保存，要么已发布到平台；发布与回退为私有是唯一的可见性操作。

## MCP 工具与参数

创建或替换模板拓扑必须先经过本文件的“设计转换流程”。转换 Skill 只能传完整 `topologyGraph` 与下表接受的元数据，绝不能传 `topologySpec`、`scenarioTemplateSpec`、`compiledProvisionSpec` 或 `compiledSpec`。

除非行内说明，写工具可按运行时 schema 接收 `idempotencyKey` 和 `confirmationId`。

| 操作 | MCP 工具 | 必填参数 | 可选参数 | Scope |
|---|---|---|---|---|
| 查看模板列表 | `range_template_list` | — | `view: platform\|mine`，默认 `platform` | `templates:read` |
| 查看模板详情 | `range_template_get` | `templateId` | — | `templates:read` |
| 新建模板 | `range_template_create` | `name`、完整 `topologyGraph` | `description`、`publicEntryProtocols`、`variableSchema`、`outputSchema`、`defaultNetworkPolicy`、操作元数据 | `templates:write` |
| 编辑信息 | `range_template_update` | `templateId`、`updates` | 更新对象内须提供名称或描述中的至少一项；操作元数据 | `templates:write` |
| 复制模板 | `range_template_clone` | `templateId` | 操作元数据 | `templates:write` |
| 检测并保存 | `range_template_topology_detect_and_save` | `templateId`、完整 `topologyGraph` | `publicEntryProtocols`、操作元数据 | `templates:write` |
| 发布到平台 | `range_template_publish` | `templateId` | 操作元数据 | `templates:publish` |
| 回退为私有 | `range_template_return_to_private` | `templateId` | 操作元数据 | `templates:publish` |
| 删除模板 | `range_template_delete` | `templateId` | 操作元数据 | `templates:delete` |

`range_template_topology_detect_and_save` 会编译并校验完整图后保存，但不会发布。拓扑修改始终重新生成完整图；没有独立预检或节点补丁工具。模板可见性只通过“发布到平台”和“回退为私有”变更。`publicEntryProtocols` 是可选的访问摘要元数据，不创建 DNAT、不替代 DNAT，也不应用为安全组规则。

创建时平台会生成 `slug`、云厂商、IaC 类型和模块路径等内部元数据。它们不是新的 `RangeDesign/v1` 输出字段，也不是 `range_template_create` 参数；旧设计中存在这些字段时，转换 Skill 仅兼容读取并丢弃，调用方不得传给 MCP。

平台固定创建 `10.0.0.0/16` 主 VPC，并附加 `172.16.0.0/16`、`192.168.0.0/16`。VPC CIDR 不是 MCP 可配置参数；每个交换机 CIDR 必须完整落在这三段之一。

## 设计转换流程

创建或修改模板拓扑必须经过：

```text
靶场设计 Skill -> RangeDesign/v1 -> 靶场拓扑转换 Skill -> 靶场编排 MCP 工具
```

1. **严格解析**：先用拒绝重复映射键的 YAML 解析器验证输入是一份完整、无截断的 `RangeDesign/v1`；每个 `switches`、`ecs`、`connections` 项均须以 `-` 开始。`connections` 使用对象数组，所有 ACL、DNAT 和安全组字段完整；解析失败时不得调用任何 MCP 工具。
2. **靶场设计 Skill** 输出本文件定义的完整 `RangeDesign/v1`。
3. **靶场拓扑转换 Skill** 只查询当前调用者可见的镜像，解析精确 `platformImageAssetId` 与 `imageId`，输出完整 `topologyGraph`。默认地域与可用区由后端基础配置注入，不查询、不输出也不传给 MCP。
4. **MCP 工具** 重新编译与校验完整图，自动生成内部派生规格后调用平台 API。

缺少镜像、IP、CIDR、连线、入口主机或 NAT 参数时，转换 Skill 必须返回缺项给设计 Skill，不得猜测。

## RangeDesign/v1 固定输出

设计 Skill 必须输出全部必填字段和全部数组；没有内容时使用空数组。可选标量字段仅在有明确业务含义时输出。

```yaml
schemaVersion: RangeDesign/v1

template:
  name: "<模板名称>"
  description: "<用途、验证目标与安全边界>"
  # 可选：仅用于入口访问摘要；真实公网转发由 switches[].dnatMappings 定义。
  publicEntryProtocols:
    - protocol: http
      port: 80

vpc:
  primaryVpcCidr: 10.0.0.0/16
  secondaryVpcCidrs:
    - 172.16.0.0/16
    - 192.168.0.0/16
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
    zoneKey: zone-dmz
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
    zoneKey: zone-dmz
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
        zoneKey: zone-dmz
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

`defaultRegion`、`defaultZoneId` 不属于 `RangeDesign/v1`，也不是模板 MCP 工具参数。后端在创建或检测保存时从基础配置注入这两个值；转换 Skill 不得调用 `cloud_config_get`，也不得在图中使用物理可用区 ID 代替逻辑 `zoneKey`。

### 设计字段与约束

| 部分 | 必须表达的事实 | 约束 |
|---|---|---|
| `template` | 名称、描述和可选入口访问摘要 | `publicEntryProtocols` 只是显示/访问摘要，不能创建、推导或代替 DNAT；地域/可用区、`slug`、云厂商、IaC 与模块路径均由平台管理，不得输出或传给 MCP。 |
| `vpc` | 固定主 CIDR、两个固定附加 CIDR、一个共享 NAT 逻辑标识 | 只能是 `10.0.0.0/16`、`172.16.0.0/16`、`192.168.0.0/16`；SNAT 与 DNAT 使用同一 NAT 网关、不同 EIP。 |
| `router` | 唯一路由器的键、名称和出口意图 | 每份设计恰好一个 Router。 |
| `switches` | 交换机 CIDR、逻辑 `zoneKey`、用途、ACL、SNAT、DNAT | 每个 Switch 的 `zoneKey` 全局唯一，是网络分区键而非阿里云可用区 ID；CIDR 必须落在三段固定 VPC CIDR 内且互不重叠；`aclRules`、`dnatMappings` 始终存在，可为空数组。 |
| `ecs` | 计算规格、角色、镜像选择、主 IP、初始化需求、所有 NIC 和安全组 | 每台 ECS 至少一个 NIC；ECS 和第一张 NIC 的 `zoneKey` 必须等于所连 Switch 的 `zoneKey`；ECS `privateIp` 等于第一个 NIC 的 `privateIp`。 |
| `nics` | NIC 键、所属交换机、IP、辅助 IP 与安全组 | 每张 NIC 都有对应 `switch -> ecs` 连接。自定义规则时显式 `securityGroupRulesMode: custom`。 |
| `connections` | Router 到每个 Switch、Switch 到每台 ECS 的完整连线 | 使用 `{ key, from, to }`；键、来源和目标必须唯一且可解析。 |

1. 交换机 CIDR、ECS 主/辅助 IP 必须属于对应 VPC 或交换机；IP 不可重复，不能使用网络或广播地址。
2. 开启 `snatEnabled` 的交换机共用 `vpc.sharedNat.natGatewayKey` 和 `snatEipKey`。DNAT 使用 `dnatEipKey`，绝不能与 SNAT EIP 相同。
3. `externalPort + protocol` 在同一 VPC 内全局唯一；DNAT 目标必须是唯一的公网入口 ECS。
4. ACL 必须给出方向、协议、端口范围、来源 CIDR、策略与优先级，策略只能是 `allow` 或 `drop`。全端口统一填写 `1/65535`，MCP 和后端会将其归一化为阿里云所需的 `-1/-1`，与协议无关；指定 TCP/UDP 端口仍写为如 `80/80`。
5. 安全组规则必须给出方向、协议、端口范围、来源 CIDR、策略与优先级，策略只能是 `accept` 或 `drop`。其端口范围也遵循 `1/65535 -> -1/-1` 的规则。
6. 设计中必须有且仅有一个公网入口 ECS：该 ECS 必须设置 `exposePublic: true`，并且必须是至少一条 DNAT 的目标。它是共享 DNAT EIP 的唯一外部访问落点，不直接绑定公网 IP；没有公网入口时模板不能保存。
7. 不输出 `customPassword`，除非用户明确要求设置该 ECS 的初始密码。

## 转换 Skill 输出与校验

转换 Skill 必须按顺序：

1. 验证 `RangeDesign/v1` YAML 的语法、字段、数组和连接对象；拒绝重复键、缺少列表标记、缺项或未知节点时返回具体路径，不得调用 MCP。
2. 不调用 `cloud_config_get`。默认地域与可用区由后端从基础配置写入模板快照，转换结果不得包含它们。
3. 调用 `platform_image_list`，将每个 `imageSelector.displayName` 精确解析为唯一、已启用的 `platformImageAssetId` 和阿里云 `imageId`；无匹配、重名或停用时停止。
4. 先输出转换回执：每个 ECS 的 `key -> platformImageAssetId + imageId`，以及每个 Switch 的唯一逻辑 `zoneKey`；回执存在未解析或重复项时不得调用写工具。
5. 校验 VPC、CIDR、IP、NAT、ACL、安全组、连线和公网入口；必须有且仅有一个 `exposePublic: true` ECS，且所有 DNAT 都指向它；每台 ECS 与第一张 NIC 必须使用所连 Switch 的 `zoneKey`；缺项或歧义返回给设计 Skill。
6. 输出 `schemaVersion: "2.0.0"` 的完整 `topologyGraph`，Router、Switch、ECS、NIC 和边的 ID 使用设计 `key`，边使用 `relationType: "manual"`。
7. 每个 ECS 节点写入 `image: displayName`（展示字段）、`imageName: displayName`、`imageId`、`platformImageAssetId`、`imageStrategy: { mode: fixed, imageId }`、`instanceTypeStrategy: { mode: auto }`、`networkInterfaces`、`portGroups` 与 `initScript`。镜像身份只由后三个 ID 字段表达；不得把资产 ID 填入 `image`。ECS 的遗留 `dnatMappings` 不创建 NAT 规则，转换结果应省略或保持为空数组。
8. 每个 Switch 节点必须写入完整 `aclRules` 与 `nat: { snatEnabled, dnatMappings }`；**公网 DNAT 仅以 `switch.nat.dnatMappings` 为准**，每条映射必须含 `key`、`targetHostId`、`externalPort`、`internalPort`、`protocol`。共享 NAT/EIP 实际资源由 MCP 编译器派生，不能提交派生规格。

转换回执和完整图均通过后，恰好调用一次 `range_template_create`，只传 `name`、可选 `description`、可选 `publicEntryProtocols` 和完整 `topologyGraph`。不要传 VPC CIDR、地域/可用区、任何平台生成或编译派生字段；创建被拒绝时停止并报告错误，禁止猜测字段或自动重试。

调用 `range_template_topology_detect_and_save` 被拒绝时，必须停止并报告原始错误；不得补猜 `modulePathOrRef`、地域、可用区或派生规格后重试。它们均由平台在服务端读取或注入。

最小结果形状：

```ts
{
  schemaVersion: '2.0.0',
  nodes: [
    { id: 'router-egress-1', kind: 'router', label: '出口路由器', ... },
    { id: 'sw-dmz', kind: 'switch', label: 'DMZ 交换机', zoneKey: 'zone-dmz', cidr: '10.0.10.0/24', ... },
    {
      id: 'ecs-web',
      kind: 'ecs',
      label: 'Web ECS',
      image: '培训渗透靶机',
      imageName: '培训渗透靶机',
      imageId: 'm-...',
      platformImageAssetId: '...',
      imageStrategy: { mode: 'fixed', imageId: 'm-...' },
      instanceTypeStrategy: { mode: 'auto' },
      nics: [...],
      ...
    },
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
4. 用户明确要求让模板停止对其他用户可见时，调用 `range_template_return_to_private`；它不删除模板及已保存拓扑。

发布、回退为私有和删除需要入口规定的危险操作确认。发布不会创建一套靶场；实际创建云资源应进入 [编排实例](./range-instances.md)。
