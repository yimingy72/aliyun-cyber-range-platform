# Image Catalog And Direct OpenTofu Execution Design

## Goal

将当前实例创建链路从“运行时依赖 `aliyun CLI` 预解析镜像 / 规格”调整为“模板直接保存最终 `image_id` 与 `instance_type`，后端直接把最终值交给 OpenTofu 创建资源”。

同时补齐平台层镜像中心，使其具备：

- 公共镜像实时查询
- 公共镜像收录到平台目录
- 自定义镜像按阿里云账号隔离保存
- 后续编排器按平台镜像目录选择镜像名，但真正执行时使用 `image_id`

## Current State

### 已有能力

- 拓扑编辑器中的 ECS 节点已保存：
  - `imageName`
  - `imageId`
  - `imageStrategy`
  - `cpu`
  - `memory`
  - `instanceTypeStrategy`
- 模板保存链路已能把这些数据写入：
  - `topologyGraph`
  - `scenarioTemplateSpec`
  - `compiledProvisionSpec`
  - `compiledSpec`
- OpenTofu module 已支持：
  - 多 switch
  - 多 ECS
  - NAT / SNAT / DNAT
  - 多网卡

### 当前问题

- 当前真实创建前，后端会在 `auto` 模式下调用 `aliyun` CLI：
  - `DescribeAvailableResource`
  - `DescribeImages`
- 这让容器态运行依赖 `aliyun` 二进制是否存在。
- 当前 `test / test2` 的最新失败根因已经确认是：
  - `spawn aliyun ENOENT`
- 也就是说，失败并不是 OpenTofu 不能创建，而是“进入 OpenTofu 之前的预解析层”在容器里缺少依赖。

## Product Direction

### 核心原则

编排器展示层可以继续使用“镜像名 / CPU / 内存”，但模板执行层必须保存最终可直接传给 OpenTofu 的值：

- `image_id`
- `instance_type`

后端创建实例时不再运行时解析这两个值，也不再依赖 `aliyun CLI`。

### 镜像中心目标

镜像中心不是单纯列表页，而是平台自己的“镜像目录入口”。它同时承担：

1. 查询当前账号当前 Region 可见的镜像
2. 将镜像收录为平台目录项
3. 让编排器使用平台目录项，而不是自由文本镜像名

## Architecture Decision

采用“平台目录直通 OpenTofu”方案：

1. 删除运行时镜像 / 规格预解析层
2. 平台在保存模板时就写入最终 `image_id` 和 `instance_type`
3. 后端只读取模板最终值并直通 OpenTofu
4. 镜像中心分成：
   - 实时快照层
   - 平台目录层

### Why this approach

- 最适合容器化
- 消除 `aliyun CLI` 运行时依赖
- 模板执行结果更稳定，不受运行时镜像列表波动影响
- 更贴合你后续“镜像名 -> image_id 映射”的产品模式

## Data Model Design

### 1. 云账号身份

在系统云配置基础上，需要补充“账号身份识别”概念。

最小需要：

- `accountUid`
- `accountName`（可选）
- `provider`
- `defaultRegion`

作用：

- 切换阿里云账号时，平台能识别为不同镜像命名空间
- 自定义镜像目录不会混淆

### 2. 镜像实时快照表

新增一张“实时镜像快照”表，反映当前账号当前区域下从阿里云实时查回来的镜像。

字段建议：

- `id`
- `provider`
- `accountUid`
- `regionId`
- `scope`：`public | custom`
- `imageId`
- `sourceImageName`
- `osType`
- `platform`
- `architecture`
- `status`
- `isAvailable`
- `lastSyncedAt`

说明：

- `public` 镜像可以不强制绑定账号，但建议仍记录查询上下文账号
- `custom` 镜像必须绑定 `accountUid`

### 3. 平台镜像目录表

新增“平台镜像目录”表，供编排器稳定引用。

字段建议：

- `id`
- `displayName`
- `imageId`
- `provider`
- `scope`：`public | custom`
- `accountUid`（仅自定义镜像必填）
- `regionId`
- `enabled`
- `sourceSnapshotId`（可选）
- `createdAt`
- `updatedAt`

作用：

- 这层才是编排器实际选择的数据来源
- 平台可以给复杂原始镜像 ID 起更友好的名字

### 4. 规格映射表

第一阶段不做数据库动态管理，先在平台内维护固定映射：

- `1c2g -> ecs.u1-c1m2.large`
- `2c4g -> ecs.c7.large`
- `4c8g -> ecs.c7.xlarge`

实现层建议：

- 先放在后端或共享常量模块
- 前端保存模板时就同步写入最终 `instanceType`

### 5. 模板执行字段

每个 ECS 节点最终需要稳定保存：

- `imageCatalogItemId`（可选，平台目录引用）
- `imageName`（展示层）
- `imageId`（执行层）
- `cpu`
- `memory`
- `instanceType`（执行层）

### 6. 当前模板结构调整

现有 `ScenarioTemplateImagePolicy` / `ScenarioTemplateInstanceTypePolicy` 仍可保留，但第一阶段需要收敛语义：

- `imagePolicy`
  - 从“auto/fixed/prefer-list 运行时解析”转为“最终 image_id 携带”
- `instanceTypePolicy`
  - 从“auto/fixed/prefer-list 运行时解析”转为“最终 instance_type 携带”

也就是说，保留结构不等于保留运行时预解析行为。

## Runtime Flow

### A. 公共镜像查询

1. 管理员进入镜像中心
2. 后端根据当前 `SystemCloudConfig` 调用阿里云 ECS OpenAPI `DescribeImages`
3. 按 `public` 范围返回实时镜像
4. 写入“镜像实时快照”表
5. 前端展示列表
6. 管理员可将某一条收录为“平台镜像目录项”

### B. 自定义镜像查询

1. 后端调用 `DescribeImages`
2. 只读取当前账号的自定义镜像
3. 快照表中按 `accountUid` 隔离保存
4. 平台目录中也按 `accountUid` 隔离

### C. 编排器选镜像

1. ECS 节点属性面板从“平台镜像目录”中选择镜像
2. 选中后同步写入节点：
   - `imageCatalogItemId`
   - `imageName`
   - `imageId`
3. 保存模板时，`scenarioTemplateSpec / compiledSpec / compiledProvisionSpec` 全部写入最终 `imageId`

### D. 编排器选规格

1. 用户继续输入 `CPU / 内存`
2. 平台根据固定映射表生成最终 `instanceType`
3. 保存模板时同步写入最终 `instanceType`

### E. 创建实例

1. API / worker 读取模板
2. 不再调用 `aliyun CLI`
3. 不再做运行时镜像 / 规格解析
4. 直接把模板中的：
   - `imageId`
   - `instanceType`
   传给 OpenTofu renderer
5. OpenTofu provider 真正去调用阿里云 API 创建资源

## What To Remove

### Remove from runtime path

以下能力从“实例创建运行时”移除：

- `resolveAvailableAliyunInstanceType()`
- `resolveAvailableAliyunImageId()`
- `execFileAsync('aliyun', ...)`
- `OPENTOFU_INSTANCE_TYPE=auto` 依赖的自动规格查询
- `OPENTOFU_IMAGE_ID=auto` 依赖的自动镜像查询

### Keep for migration period only

现有字段可暂时保留，但语义改为：

- 仅用于兼容历史数据
- 新模板必须直接带最终 `imageId / instanceType`

## UI Scope

### 镜像中心

第一阶段镜像中心包含两个模块：

1. `公共镜像`
   - 实时拉取
   - 搜索
   - 收录到平台目录

2. `自定义镜像`
   - 按当前账号实时拉取
   - 搜索
   - 显示当前账号上下文
   - 收录到平台目录

### 编排器

ECS 属性面板需要从当前自由文本模式演进为：

- 展示镜像名称
- 保留镜像 ID
- 规格字段仍然显示为 CPU / 内存
- 后台同步生成 `instanceType`

## Migration Strategy

### Existing templates

历史模板可能只具备：

- `cpu/memory`
- `imageName`
- `imageId`
- `instanceTypeStrategy.mode = auto`

迁移策略：

1. 如果已有 `imageId`
   - 直接视为最终执行值
2. 如果已有 `cpu/memory`
   - 根据映射表补出 `instanceType`
3. 如果历史模板缺少 `imageId`
   - 这类模板在真正创建前需要显式提示不完整，要求重新保存模板

### Existing instances

已有实例不做运行中迁移，只影响后续新建实例。

## Risks

### 1. 模板历史不完整

旧模板如果只有镜像名、没有稳定 `imageId`，去掉预解析后会导致无法创建。  
因此必须明确识别并阻止这类模板直接启动创建。

### 2. 规格映射表覆盖不足

如果只维护少量固定映射，某些 `CPU/内存` 组合可能找不到对应规格。  
第一阶段需要限制编排器只允许受支持组合。

### 3. 多账号自定义镜像混淆

如果不绑定 `accountUid`，自定义镜像目录在切账号后会污染。  
因此 `custom` 镜像目录必须账号隔离。

## Out of Scope

- 云市场镜像接入
- 镜像导出/删除阿里云镜像本体
- 后台可视化维护规格映射表
- 多 Region 镜像目录联邦
- 模板批量迁移脚本的完整后台页面

## Recommended Delivery Phases

### Phase 1

- 去掉运行时 `aliyun CLI` 预解析依赖
- 模板创建链路直接使用最终 `imageId + instanceType`
- 修复 `test / test2` 真实创建链路

### Phase 2

- 镜像中心：实时查询公共镜像与自定义镜像
- 支持收录到平台目录

### Phase 3

- 编排器改为从平台镜像目录选镜像
- 保存 `imageCatalogItemId + imageName + imageId`

### Phase 4

- 完善历史模板迁移与后台运营能力
