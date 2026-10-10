# 靶场编排

管理综合靶场模板及其完整拓扑。模板要么为私有已保存，要么已发布到平台；发布与回退为私有是唯一的可见性操作。

## MCP 工具与参数

创建或替换模板拓扑需按本文件的设计转换合同整理完整图。转换流程 只能传完整 `topologyGraph` 与下表接受的元数据，绝不能传 `topologySpec`、`scenarioTemplateSpec`、`compiledProvisionSpec` 或 `compiledSpec`。

除非行内说明，写工具可按运行时 schema 接收 `idempotencyKey` 和 `confirmationId`。

| 操作 | MCP 工具 | 必填参数 | 可选参数 | Scope |
|---|---|---|---|---|
| 查看模板列表 | `range_template_list` | — | `view: platform\|mine`，默认 `platform` | `templates:read` |
| 查看模板详情 | `range_template_get` | `templateId` | — | `templates:read` |
| 新建模板 | `range_template_create` | `name`、完整 `topologyGraph` | `description`、`publicEntryProtocols`、`variableSchema`、`outputSchema`、`defaultNetworkPolicy`、操作元数据 | `templates:write` |
| 编辑信息 | `range_template_update` | `templateId`、`updates` | 更新对象内须提供名称或描述中的至少一项；操作元数据 | `templates:write` |
| 复制模板 | `range_template_clone` | `templateId` | 操作元数据 | `templates:write` |
| 检测并保存 | `range_template_topology_detect_and_save` | `templateId`、`expectedRevision`、完整 `topologyGraph` | `publicEntryProtocols`、操作元数据 | `templates:write` |
| 发布到平台 | `range_template_publish` | `templateId` | 操作元数据 | `templates:publish` |
| 回退为私有 | `range_template_return_to_private` | `templateId` | 操作元数据 | `templates:publish` |
| 删除模板 | `range_template_delete` | `templateId` | 操作元数据 | `templates:delete` |

`range_template_topology_detect_and_save` 会编译并校验完整图后保存，但不会发布。拓扑修改始终重新生成完整图；没有独立预检或节点补丁工具。模板可见性只通过“发布到平台”和“回退为私有”变更。`publicEntryProtocols` 是可选的访问摘要元数据，不创建 DNAT、不替代 DNAT，也不应用为安全组规则。

创建时平台会生成 `slug`、云厂商、IaC 类型和模块路径等内部元数据。它们不是新的 `RangeDesign/v1` 输出字段，也不是 `range_template_create` 参数；旧设计中存在这些字段时，转换流程 仅兼容读取并丢弃，调用方不得传给 MCP。

平台固定创建 `10.0.0.0/16` 主 VPC，并附加 `172.16.0.0/16`、`192.168.0.0/16`。VPC CIDR 不是 MCP 可配置参数；每个交换机 CIDR 必须完整落在这三段之一。

## 设计转换流程

创建或替换模板拓扑需要完整图与可解析的设计事实，不要求存在额外“转换 Skill”工具。模板查询、克隆、名称/描述编辑及发布管理直接使用对应工具，不执行设计转换。

- 用户提供 `RangeDesign/v1` YAML 时，先用拒绝重复映射键的解析器读取。拒绝截断、缺项、无效类型、未知节点和重复地址；`connections` 必须是 `{ key, from, to }` 对象数组。解析失败停止该设计写入，指出错误路径，不用克隆或参数试错绕过。独立只读请求仍可执行。
- 用户用文字描述设计时，可整理成下面的 `RangeDesign/v1` 再转换；缺少会影响资源、入口或镜像选择的事实时先澄清。IP 与网段按用户约束设计并展示，已有云/平台 ID 必须来自查询，不能虚构。
- 修改已有图时，从 `range_template_get` 的完整最新图保留未修改字段。只读响应移除的密码不能用空值或猜测覆盖；涉及既有密码保持时按工具和服务端保存合同处理。
- 用 `platform_image_list` 解析当前空间可见、可用镜像；只补充必要查询，不要求固定调用次数。不为编译模板查询云凭据或自行选择物理地域/可用区。
- 提交完整 `topologyGraph`。MCP 和 API 编译、校验并从基础配置注入执行地域/可用区与派生规格。合同/编译校验失败时保留错误与转换材料，修复明确错误或请求澄清后才能发起新的写入；不得猜字段、删除约束、克隆或创建空模板来绕过。

## RangeDesign/v1 固定输出

设计步骤必须输出全部必填字段和全部数组；没有内容时使用空数组。可选标量字段仅在有明确业务含义时输出。

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

`defaultRegion`、`defaultZoneId` 不属于 `RangeDesign/v1`，也不是模板 MCP 工具参数。后端在创建或检测保存时从基础配置注入这两个值；转换流程 不得调用 `cloud_config_get`，也不得在图中使用物理可用区 ID 代替逻辑 `zoneKey`。

### 设计字段与约束

| 部分 | 必须表达的事实 | 约束 |
|---|---|---|
| `template` | 名称、描述和可选入口访问摘要 | `publicEntryProtocols` 只是显示/访问摘要，不能创建、推导或代替 DNAT；地域/可用区、`slug`、云厂商、IaC 与模块路径均由平台管理，不得输出或传给 MCP。 |
| `vpc` | 固定主 CIDR、两个固定附加 CIDR、一个共享 NAT 逻辑标识 | 只能是 `10.0.0.0/16`、`172.16.0.0/16`、`192.168.0.0/16`；SNAT 与 DNAT 使用同一 NAT 网关、不同 EIP。 |
| `router` | 唯一路由器的键、名称和出口意图 | 每份设计恰好一个 Router。 |
| `switches` | 交换机 CIDR、逻辑 `zoneKey`、用途、ACL、SNAT、DNAT | 每个 Switch 的 `zoneKey` 全局唯一，是网络分区键而非厂商物理可用区 ID；CIDR 必须落在三段固定 VPC CIDR 内且互不重叠；`aclRules`、`dnatMappings` 始终存在，可为空数组。 |
| `ecs` | 计算规格、角色、镜像选择、主 IP、初始化需求、所有 NIC 和安全组 | 每台 ECS 至少一个 NIC；ECS 和第一张 NIC 的 `zoneKey` 必须等于所连 Switch 的 `zoneKey`；ECS `privateIp` 等于第一个 NIC 的 `privateIp`。 |
| `nics` | NIC 键、所属交换机、IP、辅助 IP 与安全组 | 每张 NIC 都有对应 `switch -> ecs` 连接。自定义规则时显式 `securityGroupRulesMode: custom`。 |
| `ecs[].dns`（可选） | `servers`、`nicIds` 和可选 `domain` | 仅 Windows 主机；`servers` 为按优先级排序的 1–4 个不重复可用 IPv4，`nicIds` 为本机真实 NIC `key`，至少选一个；`domain` 为合法 ASCII AD DNS 域名，用于 SRV 核验。省略整个 `dns` 表示自动 DNS，不传 `null` 或空服务器列表。 |
| `connections` | Router 到每个 Switch、Switch 到每台 ECS 的完整连线 | 使用 `{ key, from, to }`；节点键全局唯一，连线键唯一，来源和目标必须可解析；同一路由器可以连接多个交换机。 |

1. 交换机 CIDR、ECS 主/辅助 IP 必须属于对应 VPC 或交换机；IP 不可重复，不能使用网络或广播地址。
2. 开启 `snatEnabled` 的交换机共用 `vpc.sharedNat.natGatewayKey` 和 `snatEipKey`。DNAT 使用 `dnatEipKey`，绝不能与 SNAT EIP 相同。
3. `externalPort + protocol` 在同一 VPC 内全局唯一；共享 DNAT EIP 可按不同公网端口映射到多台 ECS，每个目标必须有连接映射所属交换机的网卡。阿里云同一 NAT 的后端 `protocol + 网卡私网 IP + internalPort` 也必须唯一，不能将两个公网端口映射到同一后端协议/IP/端口。
4. ACL 必须给出方向、协议、端口范围、来源 CIDR、策略与优先级，策略只能是 `allow` 或 `drop`。全端口统一填写 `1/65535`，MCP 和后端会将其归一化为阿里云所需的 `-1/-1`，与协议无关；指定 TCP/UDP 端口仍写为如 `80/80`。
5. 安全组规则必须给出方向、协议、端口范围、来源 CIDR、策略与优先级，策略只能是 `accept` 或 `drop`。其端口范围也遵循 `1/65535 -> -1/-1` 的规则。
6. 腾讯云当前 DNAT 所属交换机必须同时启用 SNAT，否则编译拒绝；纯内网拓扑可以均关闭。公网入口仅由实际 `switch.nat.dnatMappings` 派生，可有多个目标 ECS，也可完全没有公网映射；不要求设置 `exposePublic`。没有 SNAT 和 DNAT 时不创建 NAT 或 EIP；只有 SNAT 时仅创建出口网络，不生成公网入口。每份拓扑仍至少有一个交换机和一台 ECS。
7. 不输出 `customPassword`，除非用户明确要求设置该 ECS 的初始密码。
8. `initScript` 只保存用户的其它启动任务，新主机未要求业务启动任务时为空；不能把平台生成的 DNS 脚本拼入图或用户脚本字段。自定义 DNS 仅作用于显式选中的 NIC，转换时将设计中的 NIC `key` 原样映射到图 NIC `id` 和 `dns.nicIds`；删除已选 NIC 必须报告错误，不能自动选其它网卡。Windows 初始化在用户脚本之前设置 DNS，IP 和网关仍使用原网络配置。若还有用户启动脚本，使用 PowerShell 内容并以 `[powershell]` 开头（也接受完整 `<powershell>...</powershell>` 包装）；不能混入 shell、bat 或 cloud-config。腾讯云要求支持 Cloudbase-init 的 Windows Server 2012 R2 及以上镜像。阿里云和腾讯云由内部启动脚本设置后独立核验，后续客体核验失败不会自动重建云实例。

## 转换流程 输出与校验

完整设计转换需满足：

1. 输入是 YAML 时验证 `RangeDesign/v1` 的语法、字段、数组和连接对象；拒绝重复键、缺项或未知节点并返回具体路径，停止该设计写入。
2. 不调用 `cloud_config_get`。默认地域与可用区由后端从基础配置写入模板快照，转换结果不得包含它们。
3. 调用 `platform_image_list`，根据用户要用的平台公开镜像或自有私有镜像选择 `view: platform` / `mine`（不能认为默认平台视图包含私有镜像），将每个 `imageSelector.displayName` 精确解析为唯一、已启用且来源可用的 `platformImageAssetId` 和所选厂商的 `imageId`；无匹配、重名或停用时停止。
4. 先输出转换回执：每个 ECS 的 `key -> platformImageAssetId + imageId`，以及每个 Switch 的唯一逻辑 `zoneKey`；回执存在未解析或重复项时不得调用写工具。
5. 校验 VPC、CIDR、IP、NAT、ACL、安全组和连线；逐条校验 DNAT 目标存在且确实连接映射所属交换机，不要求公网映射或唯一公网目标；每台 ECS 与第一张 NIC 必须使用所连 Switch 的 `zoneKey`；缺项或歧义返回给设计步骤。
6. 输出 `schemaVersion: "2.0.0"` 的完整 `topologyGraph`，Router、Switch、ECS、NIC 和边的 ID 使用设计 `key`，边使用 `relationType: "manual"`。
7. 每个 ECS 图节点写入 `image: displayName`（展示字段）、`imageName: displayName`、`imageId`、`platformImageAssetId`、`imageStrategy: { mode: fixed, imageId }`、`instanceTypeStrategy: { mode: auto }`、`nics`、`portGroups` 与用户 `initScript`。镜像身份由 `platformImageAssetId`、`imageId` 和 `imageStrategy.imageId` 表达；不得把资产 ID 填入 `image`。ECS 的遗留 `dnatMappings` 不创建 NAT 规则，转换结果应省略或保持为空数组。
8. 每个 Switch 节点必须写入完整 `aclRules` 与 `nat: { snatEnabled, dnatMappings }`；**公网 DNAT 仅以 `switch.nat.dnatMappings` 为准**，每条映射必须含 `key`、`targetHostId`、`externalPort`、`internalPort`、`protocol`。共享 NAT/EIP 实际资源由 MCP 编译器派生，不能提交派生规格。
9. 设计显式要求 Windows 自定义 DNS 时，在对应 ECS 图节点保留 `dns: { servers: [...], nicIds: [...], domain?: ... }`，例如 `dns: { servers: ['10.0.50.10'], nicIds: ['nic-member-1'], domain: 'lab.example' }`。根据真实镜像操作系统元数据判断 Windows，不能靠显示名猜测。省略 `dns` 的节点不生成 DNS 配置；域成员的所有 DNS 服务器应能解析 AD 域。

转换回执和完整图均通过后，调用 `range_template_create`，只传 `name`、可选 `description`、可选 `publicEntryProtocols` 和完整 `topologyGraph`。不要传 VPC CIDR、地域/可用区、任何平台生成或编译派生字段；创建被拒绝时停止并报告错误，禁止猜测字段或盲目重试。

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

1. 首次创建：由转换流程 输出完整图，调用 `range_template_create`。
2. 编辑拓扑：从最新模板详情与完整修改结果生成图，调用 `range_template_topology_detect_and_save`，将读取的 `revision` 传为 `expectedRevision`（至少 1）。版本冲突后重新读取并整理变更，不把旧图直接配上新版本号覆盖。
3. 用户明确要求开放给其他用户时，确认模板 ID 和影响范围后调用 `range_template_publish`。
4. 用户明确要求让模板停止对其他用户可见时，调用 `range_template_return_to_private`；它不删除模板及已保存拓扑。

发布、回退为私有和删除需要入口的用户授权与平台确认合同。发布不会创建一套靶场；实际创建云资源应进入 [编排实例](./range-instances.md)。
