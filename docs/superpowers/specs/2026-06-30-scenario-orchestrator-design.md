# 靶场编排器重构设计

- 日期：2026-06-30
- 状态：进行中，已按参考站点 `scene-detail?id=141` 完成第二轮校准
- 设计流程：`brainstorming` + `superpowers` 计划化重构
- 目标范围：`/admin/scenarios` 与 `/admin/scenarios/[scenarioId]`，以及对应前端图模型、编译链路、后端兼容校验

## 0. 文档状态说明（2026-07-02）

这份文档当前仍然有效，但它的重点已经收敛为：

- 前端编排器交互
- 拓扑图模型
- `compiledProvisionSpec` 编译契约

截至 2026-07-02，实例创建链路的“最终 Docker 部署与 OpenTofu 执行方式”已经拆出独立主线，请务必同时阅读：

- [2026-07-02-docker-opentofu-provisioning-alignment-design.md](/Users/yym/Documents/阿里云For综合靶场竞赛平台/docs/superpowers/specs/2026-07-02-docker-opentofu-provisioning-alignment-design.md)

当前明确结论：

- 编排器方向保持不变：`router / switch / ecs`
- 前端核心产物保持不变：`topologyGraph / scenarioTemplateSpec / compiledProvisionSpec`
- 当前真正待收口的问题，不再是前端编排表达，而是平台内 OpenTofu 执行方式需要对齐历史成功 smoke 路径

## 0. 本轮校准结论

当前仓库虽然已经进入“三栏式编排器”阶段，但实现仍没有真正贴住参考站点。问题不在于字段不够，而在于：

- 布局骨架还保留通用后台卡片心智，不像真正的在线编排工作台
- 画布还在渲染推导关系，而不是只展示真实拓扑边
- 节点视觉、连线视觉、选中反馈、右键配置入口都过于草稿
- 属性面板虽有字段，但没有形成清晰、稳定、可快速操作的配置器
- 前端图模型仍掺杂 legacy 字段，说明旧模板编辑器心智还没有收干净

因此，本轮不是“补几个字段”，而是：

- 继续保留后端可用的 `compiledProvisionSpec -> OpenTofu` 主链路
- 以前端交互与布局为主，尽量复刻参考站点 `scene-detail?id=141`
- 把当前编排页真正重构成“左资源栏 + 中画布 + 右属性栏”的在线编排器

## 0.1 参考站点二次审计结论

本轮已再次实测参考页 `https://reversi-mgt.chaitin.net/targets/scenario-base/scene-detail?id=141`，确认到以下关键点：

- 页面主体是固定工作台，不是普通后台卡片拼接
- 顶部工具栏在画布区上方，动作稳定收敛为：
  - `AI搭建拓扑`
  - `删除选中`
  - `全屏`
  - `退出编辑模式`
  - `保存拓扑`
- 左栏资源面板文案与结构是：
  - `点击添加节点，无需拖动`
  - `主机设备 / 虚拟主机`
  - `网络设备 / 路由器 / 交换机`
- 中间画布技术上是单 canvas 网络画布，说明它的产品心智就是“画布优先”
- 顶部提示语固定强调两件事：
  - 点击两个节点进行连线
  - 右键点击节点修改配置
- 这意味着编排页最核心的交互，不是模式切换，也不是表单先行，而是：
  - 先在画布上放置与连接
  - 再从右侧进入节点配置

## 0.2 本轮强约束

这些约束从现在开始视为最终约束：

- 编排页必须尽量复刻参考站点的工作台布局与密度
- 不再允许保留“通用后台三张卡片”式骨架
- 画布只展示真实 `edges`，不再自动推导伪关系边
- 前端一等节点只保留：
  - `router`
  - `switch`
  - `ecs`
- `ACL / NAT / SNAT / DNAT / 安全组 / 多网卡` 都是节点配置，不是画布一等节点
- 页面进入后直接是可编排状态，不额外做内部“编辑模式 / 连线模式”切换
- 节点图标使用你提供的资源：
  - `/Users/yym/Downloads/Router.svg`
  - `/Users/yym/Downloads/Switch.svg`
  - `/Users/yym/Downloads/Server.svg`

## 1. 背景

当前仓库已经完成了平台级重构：

- 后台模块收敛为 `靶场编排 / 靶场实例 / 镜像中心 / 基础配置`
- 编排页已经切到 `scenario` 语义
- 前后端已经具备 `单 VPC + 多 switch + 多 ECS` 的 OpenTofu 编排基础

但“靶场编排器”本身仍然没有进入可用状态。当前主要问题不是字段不够，而是：

- 画布还不是画布，只是分层列表
- 节点模型还混着 `nat_gateway / eip / acl / dnat_entry` 这类资源节点心智
- ECS / switch 的关键配置还没有按真实编排场景收进节点属性里
- 前端图数据与“从拓扑生成 OpenTofu 输入”的关系还不够直接

本次设计目标不是继续微调页面，而是把“靶场编排”真正提升为第一阶段核心工作台。

## 1.2 当前实现与目标的核心差距

基于当前代码审查，最关键的偏差有：

- `template-canvas.tsx` 还会基于 `zoneKey` 和默认 router 推导展示关系边，这会污染真实拓扑
- `template-editor-screen.tsx` 仍保留较多 legacy 默认字段和 `schemaVersion: '1.0.0'` 的旧图模型痕迹
- `template-property-panel.tsx` 虽然有字段，但仍是“后台表单块”，不够像在线编排配置器
- `template-node-palette.tsx` 左栏还有英文残留与占位式描述
- `globals.css` 中编排页仍以 `template-editor-panel` 这种通用卡片为主，不像单独的工作台布局

所以实现策略要变成：

- 先把工作台骨架改对
- 再把画布交互和节点视觉改对
- 最后把右侧属性面板收成真实配置器

## 1.1 本次重构边界

本次靶场编排器重构，前端不受当前已有编排页实现约束。

明确来说：

- 可以忽略当前已有的“分层列表式画布”
- 可以忽略当前已有的属性面板布局
- 可以忽略当前已有的第一阶段错误节点模型
- 只保留：
  - 当前路由入口
  - 当前模板读写接口
  - 当前后端编译与 OpenTofu 执行链路

也就是说，这次不是“修现有编排器”，而是：

- 以前端交互层面参考目标站点为蓝本重构
- 以后端 `compiledProvisionSpec -> OpenTofu` 这条链路为交付终点重构

## 2. 参考平台真实拆解

本次设计不是只看截图推断，而是实际访问并操作了：

- `https://reversi-mgt.chaitin.net/targets/scenario-base/scene-detail?id=140`
- `https://reversi-mgt.chaitin.net/targets/scenario-base/scene-detail?id=141`

这意味着本次前端交互设计的最高优先级不是“延续当前仓库组件结构”，而是：

- 尽可能复刻参考页的编排工作方式
- 在不违背我们后端数据契约的前提下，最大化靠近参考页

### 2.1 已验证的整体结构

参考页在进入 `编辑模式` 后，界面固定为三栏：

- 左侧：资源面板
- 中间：拓扑画布
- 右侧：节点属性面板

顶部工具栏包含：

- `AI搭建拓扑`
- `删除选中`
- `全屏`
- `退出编辑模式`
- `保存拓扑`

编辑提示文案明确写的是：

- `点击两个节点进行连线；右键点击节点修改配置`

这说明它的交互主轴不是“表单驱动”，而是：

- 先在画布上工作
- 再在右侧改属性

### 2.1.1 布局骨架结论

参考站点的工作台骨架可以收敛为：

- 顶部工具栏
- 左侧资源栏
- 中间大画布
- 右侧条件式属性面板

其中最重要的不是“三栏”这个词，而是：

- 中间画布必须明显比左右两栏更大
- 左右两栏是辅助区，不是和画布等权的卡片
- 右侧属性区应在未选中节点时尽量克制，选中节点后快速进入配置态

### 2.2 已验证的节点添加方式

参考页当前左栏文案是：

- `点击添加节点，无需拖动`

左侧资源按两组展示：

- 主机设备：`虚拟主机`
- 网络设备：`路由器 / 交换机`

实际点击左侧 `虚拟主机` 后：

- 页面弹出成功提示
- 画布新增一个主机节点

视觉上该新主机会进入当前拓扑，并接入现有网络结构。基于页面行为判断，第一阶段不必优先做“从左栏拖到画布”；`点击添加 + 画布内拖动位置` 更适合当前实现节奏。

### 2.2.1 节点图标与辨识方式

参考站点的左栏与画布都依赖图标来做资源辨识，因此我们这一版不能继续只用文字块。

本平台第一阶段直接采用你提供的三张图标：

- 路由器：`Router.svg`
- 交换机：`Switch.svg`
- ECS 主机：`Server.svg`

使用原则：

- 左栏资源项要有图标 + 中文主标题 + 英文小字
- 画布节点也必须有图标，不再只是纯文字按钮
- 图标是识别层，不承担状态表达；状态仍由选中、连线、禁用、删除等交互反馈承担

### 2.3 已验证的交换机配置

右键交换机后，右侧属性面板分为三段：

#### 基础信息

- 设备类型：交换机
- 名称
- 描述

#### 网段配置

- 网段信息配置
- CIDR 被拆成分段输入
- 最后一段网络位固定为 `0`
- 前缀长度可选

#### ACL 配置

包含：

- `添加ACL规则`
- 默认 `inbound` / `outbound` 规则
- 每条规则有编辑和删除入口
- 字段至少包括：
  - 方向
  - 协议
  - 源 IP
  - 目标 IP
  - 端口
  - 动作
  - 优先级

#### NAT 网关

包含：

- 说明文案：`DNAT用于配置网段内入网规则；SNAT用于开启网段内主机设备访问互联网`
- `允许访问互联网（SNAT）` 开关
- `配置入网规则` 区块

DNAT 配置为一个规则列表，每条规则包含：

- 主机设备选择
- 公网端口
- 内网端口
- 协议
- 删除入口

这说明在产品心智上：

- SNAT 是交换机级策略
- DNAT 也是交换机级配置面板里的能力
- 但 DNAT 的目标是交换机下某台 ECS 的某个端口

### 2.3.1 交换机面板对我们的直接要求

结合参考站点与当前业务，本平台第一阶段交换机面板应直接收敛为四段：

- 基础信息
- 网段配置
- ACL 配置
- NAT 配置

并且必须满足：

- `CIDR` 不再只是一个随意输入框，至少要表现成“更明确的网段配置区”
- ACL 规则要支持结构化增删改
- NAT 区明确拆开：
  - `SNAT` 开关
  - `DNAT` 规则列表
- `DNAT` 规则目标必须来自当前拓扑中可选的 ECS 主机

### 2.4 已验证的 ECS 配置

右键 ECS 后，右侧属性面板至少包含两层：

#### 基础信息

- 设备类型：虚拟主机
- 名称
- 镜像选择
- 主机名
- CPU
- 内存
- 描述
- 启动优先级
- 启动等待时间（秒）

#### 网卡配置

点击 `网卡配置` 后可以看到：

- `添加网卡`
- 每张网卡卡片
- 网卡级 `安全组规则`
- 删除网卡

每张网卡至少包含：

- 交换机
- 私网 IP
- 辅助 IP
- 内联安全规则摘要

已验证的规则摘要字段包括：

- 方向
- 协议
- 源 IP
- 目标 IP
- 端口
- 动作
- 优先级

这说明在产品心智上：

- 安全规则属于 ECS 网卡
- 多网卡是一等公民
- 固定私网 IP 是模板配置的一部分

### 2.4.1 ECS 面板对我们的直接要求

ECS 面板必须收敛成两层主任务：

- 基础信息
- 网卡配置

第一阶段虽然可以保留初始化脚本能力，但它不应压过基础信息和网卡配置，不应成为面板视觉中心。

基础信息至少要稳定承接：

- 镜像名 / 镜像 ID
- 实例名
- 主机名
- CPU
- 内存
- 启动优先级
- 启动等待时间

网卡配置至少要稳定承接：

- 所属交换机
- 固定私网 IP
- 辅助 IP
- 网卡级安全规则

### 2.5 路由器定位

参考页的 `路由器` 节点存在于画布中，但本次操作中没有打开出有效配置项。结合你当前第一阶段目标，路由器在我们平台里应代表：

- 单个 VPC 根节点

第一阶段不需要复杂路由表编辑，只要承担“拓扑根”和“VPC 语义锚点”即可。

## 3. 方案比较

### 方案 A：在现有编辑器上继续补字段

做法：

- 保留现有列表型“画布”
- 继续给现有 `TemplateNode` 补字段
- 继续沿用当前 `nat_gateway / eip / acl / dnat_entry` 等独立资源节点心智

优点：

- 改动小
- 短期能继续往前走

缺点：

- 会把当前错误心智固化下来
- 无法形成真正的拓扑编辑器
- 用户看到的模型仍然和真实编排对象不一致

结论：

- 不推荐

### 方案 B：以“场景图 JSON”为核心，重做三节点编排器

做法：

- 前端只保留 `router / switch / ecs` 三类主节点
- NAT / ACL / 安全组 / 多网卡全部收进节点属性
- 画布成为真正的主工作区
- 编译器从图 JSON 生成 `ScenarioTemplateSpec` 和 OpenTofu 输入

优点：

- 最符合你的业务心智
- 与当前后端能力兼容
- 后续可继续扩展更多节点类型，但不需要现在过度抽象

缺点：

- 需要重写一部分前端图模型和属性面板

结论：

- 推荐

### 方案 C：直接做通用资源引擎

做法：

## 4. 最终设计决策

本轮正式采用：

- 方案 B：以 `topologyGraph + scenarioTemplateSpec + compiledProvisionSpec` 为核心
- 但前端实现层进一步收紧为“参考站点式在线编排器”

也就是：

- 图是主要工作界面
- JSON 是真实蓝图
- OpenTofu 只消费编译后的结构

## 5. 页面与交互设计

### 5.1 编排页骨架

`/admin/scenarios/[scenarioId]` 重构后固定为：

- 顶部工具栏
- 左资源面板
- 中画布
- 右属性面板

顶部工具栏保留这些动作：

- 返回靶场列表
- 删除选中
- 保存草稿
- 发布编排

可以额外保留：

- 生成默认骨架

但它不能再以主按钮姿态破坏主工作流，应降为辅助动作。

### 5.2 资源面板

左栏资源面板第一阶段只保留：

- `虚拟主机`
- `路由器`
- `交换机`

交互固定为：

- 点击新增节点
- 不要求拖拽创建
- 新增后自动选中该节点

### 5.3 画布

中间画布必须满足：

- 只渲染真实节点
- 只渲染真实 `edges`
- 不再自动生成推导边
- 节点支持拖动并写回 `position`
- 节点支持选中高亮
- 连线视觉要明显强于当前的普通直线
- 节点卡片要包含图标，不再只用纯文字按钮

### 5.4 节点交互

本平台最终采用的节点交互为：

- 左键单击：选中节点
- 左键再次点击另一节点：如果存在待连线起点，则尝试建立连接
- 右键：打开该节点属性面板

为了减少误触，连线逻辑需要比当前更明确：

- 只有显式处于“待连线起点”状态时，第二次点击别的节点才建立连接
- 不允许继续把“选中节点”和“连线起点”做成模糊的同一状态

### 5.5 属性面板

右栏属性面板采用“选中节点后显示，未选中时保持轻量占位”的策略。

按节点类型拆分：

- `router`
  - 名称
  - 描述
- `switch`
  - 基础信息
  - 网段配置
  - ACL 配置
  - NAT 配置
- `ecs`
  - 基础信息
  - 网卡配置
  - 安全规则

## 6. 数据与编译约束

### 6.1 前端图数据

前端图数据继续使用 `ScenarioGraphDraft`，但本轮要清理旧字段心智：

- 不再让 legacy 字段主导节点摘要和 UI 表达
- `edges` 只保存真实连接
- `schemaVersion` 随本轮升级到新的编排器版本

### 6.2 编译链路

编译主链路保持不变：

- `topologyGraph`
- `scenarioTemplateSpec`
- `compiledProvisionSpec`

其中实例创建继续默认消费：

- `compiledProvisionSpec`

### 6.3 创建实例策略

继续使用当前确认过的规则：

- 创建实例始终使用最新草稿
- 发布状态只影响模板可见性，不决定实例化数据源

## 7. 本轮实施优先级

本轮开发顺序固定为：

1. 先重构编排页工作台骨架与画布
2. 再重构节点交互与连线规则
3. 再重构右侧属性面板
4. 最后回归保存 / 发布 / 实例化闭环

如果这四步里前两步没改对，后面继续补字段都没有意义。

- 上来就引入“资源类型注册表 + 动态表单 + 通用编译适配器”

优点：

- 长期看更通用

缺点：

- 第一阶段明显过重
- 会把时间花在框架抽象上，不是交付编排器

结论：

- 当前不做

## 4. 设计结论

采用方案 B：

- UI 只暴露 `路由器 / 交换机 / ECS 主机`
- 真实蓝图存为 `ScenarioGraphDraft`
- NAT / ACL / 安全组等扩展资源不再作为第一阶段独立画布节点
- 编排页以“画布 + 属性面板”为中心
- OpenTofu 仍然只吃归一化后的结构化 JSON

同时补充两个强约束：

- 前端编排器允许整体替换当前实现，不为旧 UI 保持兼容
- 后端链路不重写方向，继续以 `compiledProvisionSpec` 作为实例创建主交付物

## 5. 主任务与范围

### 主任务

管理员在一个页面里完成：

- 新建靶场拓扑
- 添加 `路由器 / 交换机 / ECS`
- 配置网段、ACL、SNAT、DNAT、多网卡、固定私网 IP、镜像和规格
- 保存并发布模板
- 用最新草稿版本创建实例

### 本次范围

- 生产级交互，不是 demo
- 覆盖完整拓扑编排页和其数据链路
- 第一阶段锁定 `单 VPC + 多 switch + 多 ECS`

### 明确不做

- 比赛 / 队伍编排
- 多 VPC
- 拖拽式复杂连线路由策略
- 通用资源工厂
- 云镜像实时拉取

## 6. 页面与交互设计

## 6.1 靶场编排列表页

列表页继续作为入口，但职责只保留：

- 展示靶场
- 新建靶场
- 编辑信息
- 进入编排
- 复制模板
- 发布 / 取消发布
- 生成实例
- 删除模板

“生成实例”必须使用最新草稿，而不是已发布快照。发布状态只代表“是否可共享 / 可见”，不应再成为实例化数据源。

## 6.2 拓扑编排页骨架

采用三栏：

- 左栏：资源面板
- 中栏：拓扑画布
- 右栏：属性面板

顶部工具条保留：

- 返回列表
- 编辑模式提示
- 删除选中
- 全屏
- 保存拓扑
- 发布模板
- 生成实例

第一阶段不保留：

- AI 搭建拓扑

## 6.3 画布交互

第一阶段采用单一在线编排模式，不再区分：

- 浏览模式
- 编辑模式
- 连线模式

用户进入页面后应始终处于“可编排”状态，体验上尽量靠近参考页：

- 左栏采用 `点击添加节点`
- 中间大画布是主工作区
- 画布内节点支持拖动位置并持久化布局
- 右键节点打开属性面板
- 在同一在线模式下完成选中、连线、删除、改属性

也就是说：

- 不通过顶部按钮切换“编辑 / 连线”两个模式
- 连线属于当前在线编排态下的一种操作，不是独立模式

连接语义在第一阶段只支持：

- `router -> switch`
- `switch -> ecs`

如果用户建立非法连接，前端直接拦截。

同时，编排页顶部工具条应更接近当前平台 `靶场实例` 页的顶栏布局：

- 左侧保留页面主标题与少量状态信息
- 右侧保留主要动作按钮
- 整体更平、更横向，不再像当前编排页那样把多种模式切换混在一起

## 6.4 节点属性面板

### 路由器

第一阶段最简：

- 名称
- 描述（可选）

同时它在语义上代表：

- VPC 根节点

不暴露复杂路由字段。

### 交换机

字段固定为：

- 名称
- 描述
- `zoneKey`
- CIDR
- 用途标签
- ACL 规则列表
- NAT 配置

NAT 配置固定为：

- `snatEnabled`
- `dnatMappings[]`

每条 `dnatMapping` 包含：

- `targetHostId`
- `externalPort`
- `internalPort`
- `protocol`

交换机不再要求用户手动创建 NAT Gateway / EIP 节点。

### ECS 主机

字段固定为：

- 实例名
- 主机名
- 镜像占位信息：`imageName / imageId`
- 规格输入：`cpu / memory`
- 描述
- 启动优先级
- 启动等待时间
- 网卡列表

每张网卡包含：

- `switchId`
- `privateIp`
- `secondaryIps[]`
- `securityGroupRules[]`

每条安全组规则包含：

- `direction`
- `protocol`
- `portRange`
- `sourceCidr`
- `policy`
- `priority`

## 7. 数据模型

## 7.1 前端主蓝图

前端保存的真实对象是 `ScenarioGraphDraft`，不是“给 OpenTofu 的最终变量”。

```ts
type ScenarioGraphDraft = {
  schemaVersion: '2.0.0';
  metadata: {
    name: string;
    description: string;
    slug: string;
  };
  layout: {
    viewport?: { x: number; y: number; zoom: number };
  };
  nodes: Array<RouterNode | SwitchNode | EcsNode>;
  edges: Array<
    | { id: string; kind: 'router-switch'; routerId: string; switchId: string }
    | { id: string; kind: 'switch-ecs'; switchId: string; ecsId: string; nicId?: string }
  >;
};
```

## 7.2 节点结构

```ts
type RouterNode = {
  id: string;
  kind: 'router';
  label: string;
  position: { x: number; y: number };
  config: {
    description?: string;
  };
};

type SwitchNode = {
  id: string;
  kind: 'switch';
  label: string;
  position: { x: number; y: number };
  config: {
    zoneKey: string;
    cidr: string;
    purpose: string;
    description?: string;
    aclRules: SwitchAclRule[];
    nat: {
      snatEnabled: boolean;
      dnatMappings: SwitchDnatMapping[];
    };
  };
};

type EcsNode = {
  id: string;
  kind: 'ecs';
  label: string;
  position: { x: number; y: number };
  config: {
    instanceName: string;
    hostName: string;
    imageName: string;
    imageId: string;
    cpu: number;
    memory: number;
    description?: string;
    bootPriority: number;
    bootWaitSeconds: number;
    nics: EcsNicConfig[];
  };
};
```

## 7.3 与当前代码的关键纠偏

当前前端 `TemplateNode` 还包含：

- `nat_gateway`
- `eip`
- `acl`
- `security_group_rule`
- `snat_entry`
- `dnat_entry`

本次设计要求：

- 这些类型从第一阶段编排 UI 主模型中移除
- 它们改为编译产物，而不是画布节点

## 8. 编译规则

前端链路固定为：

`ScenarioGraphDraft -> ScenarioTemplateSpec -> compiledProvisionSpec -> OpenTofu 输入`

这里的关键不是“前端画布长什么样”，而是：

- 画布如何编辑都可以重构
- 但最终必须稳定产出当前后端可消费的 `compiledProvisionSpec`

当前后端的真实主链路已经明确：

- 模板版本持久化：`topologyGraph / scenarioTemplateSpec / compiledProvisionSpec`
- Worker 实例创建入口优先读取：`compiledProvisionSpec`
- `buildEnterpriseProvisionPlan()` 会从 `compiledProvisionSpec` 解析：
  - `topology`
  - `networkZones`
  - `hosts`
  - `natGateways`
  - `eips`
  - `snatEntries`
  - `dnatEntries`
  - `securityGroupRules`
  - `aclRules`
- `OpenTofuRangeProvisioner.create()` 再基于该 plan 渲染并执行 OpenTofu

因此本次前端重构的正确落点是：

- 参考站点式编排交互
- 当前仓库后端契约式编译出口

### 8.1 编译约定

- 单个 `router` 编译为 VPC 根
- 每个 `switch` 编译为一个 `networkZone`
- 每个 `ecs` 编译为一个 `host`
- `switch.aclRules` 编译为 `access.aclRules`
- `ecs.nics[].securityGroupRules` 编译为 `access.securityGroupRules`
- 若某 `switch` 开启 `snatEnabled` 或存在 `dnatMappings`，则自动生成该交换机的逻辑 NAT 资源
- `switch.nat.dnatMappings` 编译为 DNAT entries

### 8.2 合成资源策略

第一阶段不让用户在画布上显式建 NAT / EIP 节点，编译期自动合成：

- `natGatewayKey = "nat-${switchId}"`
- `eipKey = "eip-${switchId}"`

这样既符合你“所有资源都由拓扑数据转换得到”的要求，也能继续复用现有 OpenTofu renderer。

补充说明：

- 用户在前端编排的是“靶场拓扑数据”
- OpenTofu 吃的是“根据拓扑数据编译出的资源清单”
- 所以前端完全可以重构成参考站点的交互骨架
- 但绝不能只停在 `topologyGraph`，必须同步产出后端要的 `compiledProvisionSpec`

## 9. 校验与错误处理

前端保存前校验：

- 必须存在且仅存在一个 `router`
- 至少存在一个 `switch`
- 每个 `switch` 必须连接到 `router`
- 每个 `ecs` 至少有一张网卡
- 每张网卡必须绑定一个 `switch`
- 每张网卡必须有固定私网 IP
- 同一交换机内私网 IP 不允许冲突
- DNAT 必须引用该交换机下的 ECS
- DNAT 的公网端口不允许重复

发布前校验：

- 必须能成功编译为 `ScenarioTemplateSpec`
- 编译结果必须能生成当前后端接受的 `compiledProvisionSpec`

实例化前校验：

- 永远使用最新草稿版本
- 若草稿未通过编译校验，则禁止创建实例

## 10. 测试策略

### 前端

- 图模型 reducer / helper 单测
- `ScenarioGraphDraft -> ScenarioTemplateSpec` 单测
- 属性面板字段映射单测
- 画布交互组件测试：
  - 点击加节点
  - 删除节点
  - 连线
  - 右键打开属性
  - 修改字段后保存

### 后端 / 编译链路

- 继续复用现有 OpenTofu renderer e2e
- 新增嵌入式 switch NAT / ACL 与 ECS NIC / SG 的编译测试

### 联调

- 通过后台编排页创建一个 `1 router + 3 switch + 3 ecs` 的场景
- 从前端保存草稿
- 发布模板
- 用草稿直接生成实例
- 验证编译任务输出的资源摘要

## 11. 本次设计的明确决定

- 第一阶段不做独立 NAT / EIP / ACL 资源节点
- 第一阶段以 `点击添加节点` 为主，不以拖资源到画布为前置要求
- 第一阶段支持画布内拖动节点位置
- 路由器当前仅作为 VPC 根语义节点
- DNAT 放在交换机的 NAT 配置中
- 实例创建永远使用最新草稿，而不是已发布版本

## 12. 对当前仓库的直接影响

优先受影响文件：

- `apps/web/components/admin/template-editor/template-canvas.tsx`
- `apps/web/components/admin/template-editor/template-property-panel.tsx`
- `apps/web/components/admin/template-editor/template-editor-screen.tsx`
- `apps/web/lib/topology-graph-to-scenario-template.ts`
- `apps/web/lib/scenario-template-spec.ts`
- `apps/web/lib/template-topology-skeleton.ts`
- `apps/web/lib/template-topology-sync.ts`

需要收敛的旧心智：

- “画布是分层列表”
- “扩展网络资源必须作为独立节点存在”
- “发布版本才是实例化来源”
- “前端需要延续当前编排器结构”

需要新增的开发共识：

- 编排器前端可以整体重做
- 只要后端模板读写接口与 OpenTofu 交付契约不被破坏，就不需要为旧 UI 保持兼容

本设计之后，编排器的主心智应该变成：

- 画布上只摆核心节点
- 所有网络与访问策略都藏在节点配置里
- 真正保存的是结构化蓝图 JSON
- OpenTofu 只是蓝图的下游执行器
