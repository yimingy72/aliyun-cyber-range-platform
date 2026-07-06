# 综合靶场编排平台重构设计

- 日期：2026-06-29
- 状态：进行中（核心重构已落地，剩余为协议层与进一步体验完善）
- 适用范围：管理后台、登录入口、靶场编排、靶场实例、云配置、拓扑编辑器、前后端编排链路

## 0. 文档状态说明（2026-07-02）

这份文档仍然是“平台级重构”的主设计记录，但它不再单独代表当前项目全貌。

截至 2026-07-02，项目状态应额外结合以下文档一起理解：

- 靶场编排器与拓扑模型主线：
  - [2026-06-30-scenario-orchestrator-design.md](/Users/yym/Documents/阿里云For综合靶场竞赛平台/docs/superpowers/specs/2026-06-30-scenario-orchestrator-design.md)
- Docker / OpenTofu / provisioning 对齐主线：
  - [2026-07-02-docker-opentofu-provisioning-alignment-design.md](/Users/yym/Documents/阿里云For综合靶场竞赛平台/docs/superpowers/specs/2026-07-02-docker-opentofu-provisioning-alignment-design.md)

当前明确结论：

- 平台级后台重构主线已经基本落地
- 前端编排模型已进入 `单 VPC + 多 switch + 多 ECS` 阶段
- 当前主要阻断点已从“页面与拓扑模型”切换为“Docker 化 OpenTofu 执行链路与 provider/runtime 对齐”

## 0. 当前实现状态（2026-06-29 更新）

当前仓库已经落地的主线结构如下：

- 单一后台登录：`/admin/login`
- 后台默认落点：`/admin/scenarios`
- 核心模块：`基础配置 / 镜像中心 / 靶场编排 / 靶场实例`
- 前端主路由：
  - `/admin`
  - `/admin/login`
  - `/admin/scenarios`
  - `/admin/scenarios/[scenarioId]`
  - `/admin/ranges`
  - `/admin/settings/cloud`
  - `/admin/image-center`
- 后端主 API：
  - `/admin/scenarios`
  - `/admin/ranges`
  - `/admin/system-config`
  - `/admin/provision-jobs`

当前已确认的真实实现边界：

- `比赛 / 队伍` 已不再属于当前产品运行面
- `RangeInstance` 已收敛为 `name + templateId + status + createdAt + lastJobId` 的主模型，且实例创建不再依赖 `competition / team`
- 前端拓扑编辑器节点主语义已收敛为 `router / switch / ecs`
- 后端 `competitions / teams` 已从公开运行面、主模块注册、repository 和测试 fixture 主线中移除
- 后端 blueprint / compiled spec 中仍保留 `hosts / hostKeys / hostIds` 等协议字段，这是当前协议层的有意保留，不再等同于前端产品心智中的“host 节点”

## 1. 重构目标

本次重构不是局部改样式，而是对当前平台进行一次面向第一阶段真实产品目标的结构性重构。

第一阶段平台定位明确为：

`面向阿里云综合靶场场景的后台编排与实例管理平台`

平台当前阶段应聚焦于 4 个核心问题：

- 后台入口统一，登录逻辑清晰
- 后台模块收敛，移除与当前目标无关的历史模块
- `靶场编排` 成为平台主工作台，承担靶场蓝图管理与拓扑编辑职责
- 前端编排结果能够稳定转换为后端可编译的 OpenTofu 输入，继续承接已具备的实例创建能力

本次重构要解决的根问题不是“UI 不够好看”，而是：

- 产品信息架构不稳定
- 旧模块命名与当前业务不一致
- 登录入口和角色分流不必要
- 靶场列表页、拓扑编辑页、实例页职责混杂
- 前端编排数据与后端 OpenTofu 编排链路之间的表达需要更明确

## 2. 产品范围

### 2.1 保留模块

后台仅保留以下 4 个一级模块：

- `基础配置`
- `镜像中心`
- `靶场编排`
- `靶场实例`

### 2.2 直接移除模块

从产品入口、导航、页面和后续文档主线中直接移除：

- `靶场总览`
- `编排任务`
- `选手登录`
- `选手入口`
- `比赛 / 队伍` 相关第一阶段页面心智
- `基础配置` 中与云配置无关的历史面板

说明：

- 当前代码里若仍存在部分历史实现，可暂时保留底层代码，作为后续清理对象
- 但它们不得继续作为现行产品结构的一部分

## 3. 登录与路由结构

### 3.1 登录策略

平台仅保留单一后台登录入口：

- 账号：`admin`
- 密码：`change-me`

登录成功后直接进入：

- `/admin/scenarios`

当前阶段不再区分管理员与选手。

### 3.2 路由结构

当前已经落地的核心路由如下：

- `/admin`
- `/admin/login`
- `/admin/scenarios`
- `/admin/scenarios/[scenarioId]`
- `/admin/ranges`
- `/admin/settings/cloud`
- `/admin/image-center`

其中：

- `scenarios` 对应“靶场编排”
- `ranges` 对应“靶场实例”

## 4. 后台信息架构

### 4.1 基础配置

第一阶段只保留 `云配置`，字段只保留：

- `云平台`
- `默认地域`
- `默认可用区`
- `AccessKey ID`
- `AccessKey Secret`

该页面定位是：

`维护实例创建时使用的默认云侧参数`

它不再承担：

- 模板管理
- Runner 管理
- 比赛 / 队伍管理
- 其他平台运营杂项

### 4.2 镜像中心

镜像中心作为一级导航保留，但第一阶段可先实现为页面壳与空状态。

未来定位：

- 查看当前云账号下镜像
- 删除镜像
- 导出镜像
- 从镜像创建单实例

第一阶段不要求接通完整后端逻辑，但需要保留明确的页面位置与未来能力心智。

### 4.3 靶场编排

`靶场编排` 是当前平台核心模块，替代旧的 `靶场模板` 叫法。

它由两个层次组成：

- `靶场列表页`
- `拓扑编排页`

列表页负责：

- 展示已有靶场蓝图
- 创建新靶场
- 发布靶场
- 复制、删除、生成实例
- 进入拓扑编排页

拓扑编排页负责：

- 编辑靶场基础信息
- 编辑单 VPC 拓扑
- 编辑节点配置
- 保存草稿
- 发布
- 生成实例

### 4.4 靶场实例

实例页只负责已启动场景的生命周期管理。

列表最小字段固定为：

- `实例名`
- `靶场名`
- `状态`
- `创建时间`
- `操作（关闭 / 销毁 / 查看详情）`

实例页不是实例编排页，也不承载历史任务看板职责。

## 5. 核心业务模型

### 5.1 靶场编排对象

产品层统一叫“靶场”，当前仓库中对外主语义已切到 `scenario`，底层仍阶段性复用 `RangeTemplate` 族模型。

第一阶段一个靶场至少包含：

- `id`
- `name`
- `description`
- `status`
- `currentDraftVersion`
- `currentPublishedVersion`
- `topologyGraph`
- `topologySpec`
- `compiledProvisionSpec`
- `createdAt`
- `updatedAt`

列表页不显示实现噪音，如：

- `slug`
- 模块路径
- 内部版本细节
- 内部 ID

### 5.2 靶场实例对象

当前主模型中，实例摘要对象至少包含：

- `id`
- `name`
- `templateId` / `scenarioName`（视聚合层而定）
- `status`
- `createdAt`
- `lastJobId`

详情对象可以额外展开：

- 公网入口
- 资源摘要
- 任务日志
- 错误摘要

### 5.3 云配置对象

第一阶段云配置对象收敛为：

- `provider`
- `defaultRegion`
- `defaultZoneId`
- `accessKeyId`
- `accessKeySecret`

## 6. 第一阶段拓扑模型

### 6.1 拓扑范围锁定

第一阶段拓扑模型锁定为：

`单个 VPC + 多 switch + 多 ECS`

这与当前后端已具备的 OpenTofu 编排能力保持一致。

当前阶段不直接支持：

- 多 VPC
- 多云混合拓扑
- 复杂跨 VPC 拓扑联动

### 6.2 节点类型

第一阶段只支持 3 类节点：

- `router`
- `switch`
- `ecs`

含义如下：

`router`

- 代表单个 VPC
- 第一阶段只允许存在 1 个
- 暂不开放复杂配置

`switch`

- 代表 VSwitch / 子网区域
- 必须挂在 `router` 下
- 需要支持配置：
  - 名称
  - CIDR
  - ACL 配置
  - SNAT 配置
  - DNAT 配置

`ecs`

- 代表主机
- 必须挂在某个 `switch` 下
- 第一阶段使用镜像占位信息，而不是接入真实镜像列表
- 需要支持配置：
  - 实例名
  - 主机名
  - 镜像名
  - 镜像 ID
  - IP 信息
  - 安全组规则

### 6.3 关系约束

第一阶段必须使用强约束，不能允许用户自由乱连。

约束如下：

- 一个靶场只能有 1 个 `router`
- `switch` 只能连接到 `router`
- `ecs` 只能连接到 `switch`
- 不允许 `ecs -> ecs`
- 不允许 `switch -> switch`
- 不允许多个 `router`

## 7. 前端主数据与后端编排链路

### 7.1 双层模型

前端主数据分为两层：

- `topologyGraph`
- `topologySpec`

其中：

- `topologyGraph` 负责画布展示、连线关系、节点布局、交互态
- `topologySpec` 负责真实编排语义

也就是说：

- 画布不是最终编排结果
- OpenTofu 也不直接读取画布
- 真正交给后端的是归一化后的拓扑 JSON

### 7.2 编排转换链

重构后的目标链路如下：

`拓扑画布交互`
-> `topologyGraph`
-> `topologySpec`
-> `normalized scenario JSON`
-> `compiledProvisionSpec`
-> `OpenTofu vars / module input`
-> `生成靶场实例`

前端职责：

- 维护和校验编排 JSON
- 保证结构合法
- 为后端提供稳定输入

后端职责：

- 编译前端拓扑 JSON
- 生成 OpenTofu 输入
- 驱动实例创建、关闭、销毁

## 8. 页面交互流程

### 8.1 登录流程

- 打开后台登录页
- 输入固定管理员账号密码
- 登录成功后进入 `靶场编排`

### 8.2 靶场编排列表页

这是登录后的默认首页。

页面要素：

- 页面标题：`靶场编排`
- 主按钮：`新建靶场`
- 搜索：按名称搜索
- 状态筛选：`全部 / 草稿 / 已发布`

列表列固定为：

- `靶场名`
- `靶场描述`
- `拓扑概览（区域 / 主机 / 节点）`
- `状态`
- `操作`

操作区建议：

- 主操作：`编排`
- 次级操作收纳于更多菜单：
  - `编辑信息`
  - `复制模板`
  - `发布模板`
  - `生成实例`
  - `删除模板`

### 8.3 新建靶场流程

点击 `新建靶场` 后：

- 弹出最小创建弹窗
- 只收集：
  - `靶场名`
  - `靶场描述`
- 创建成功后立即进入拓扑编排页

后端初始化默认骨架：

- 1 个 `router`
- 1 个默认 `switch`
- 0 个 `ecs`

### 8.4 拓扑编排页

拓扑编排页是核心编辑器，固定为 4 区结构：

- 顶部工具栏
- 左侧资源栏
- 中央拓扑画布
- 右侧属性面板

顶部工具栏保留：

- 返回列表
- 当前靶场名
- 草稿 / 已发布状态
- `保存草稿`
- `发布`
- `生成实例`

左侧资源栏第一阶段仅保留：

- `ECS`
- `Router`
- `Switch`

中央画布负责：

- 展示单 VPC 拓扑
- 支持节点新增
- 支持选中节点
- 支持连线
- 支持删除节点

右侧属性面板负责：

- 按选中节点类型展示专属配置
- 未选中节点时显示引导文案

### 8.5 生成实例流程

目标流程仍然是从列表页或拓扑编排页点击 `生成实例` 后：

- 进入极短确认流程
- 填写实例名
- 确认生成

当前产品主线已不再引入比赛、队伍等历史对象。

说明：

- 当前仓库已经移除了旧的实例创建表单心智，实例运行期管理已经收口
- 下一轮若继续扩展，将围绕“靶场编排 -> 生成实例”的最小前台闭环继续补强，而不是回退到比赛/队伍模型

### 8.6 靶场实例页

实例页只负责管理运行中的实例。

最小操作：

- `关闭`
- `销毁`
- `查看详情`

详情展示：

- 公网入口
- 资源摘要
- 任务日志
- 错误摘要

## 9. 视觉与 UI 方向

### 9.1 风格主线

确认采用：

- `浅色艺术编辑器风`
- `左侧固定导航 + 右侧宽内容区`
- `清晰、简约、克制，但有设计感`

明确放弃：

- HTB 风格
- 深色安全后台风格
- 黑底荧光色主导

### 9.2 视觉目标

整体体验应更像：

`专业编排工具`

而不是：

- 运营报表后台
- 安全大屏
- 说明页式 SaaS

### 9.3 页面骨架

全站统一：

- 左侧轻量导航
- 右侧宽内容区
- 页面内只突出一个主任务

### 9.4 配色方向

建议采用：

- 背景：暖白或浅灰白
- 面板：纯白或极浅灰
- 分隔：低对比细边框
- 主强调色：偏冷的青蓝 / 蓝绿
- 状态色：克制使用

### 9.5 排版方向

设计感主要来自：

- 排版
- 比例
- 对齐
- 留白
- 面板结构

而不是来自夸张色彩或过重装饰。

### 9.6 核心页面视觉重点

登录页：

- 干净的工具入口感
- 大留白
- 简洁品牌区
- 克制文案

靶场编排列表页：

- 列表是主角
- 搜索和筛选像工具栏
- 表头、行信息、状态、操作层级清晰

拓扑编排页：

- 更像编辑器而不是表单页
- 画布是视觉中心
- 资源栏与属性栏克制稳定

靶场实例页：

- 更偏管理工具
- 列表清晰
- 详情整洁展开

## 10. 第一阶段非目标

当前阶段不纳入本次重构目标：

- 真实镜像中心后端逻辑
- 多 VPC 拓扑
- 多云混合拓扑真实编排
- 比赛 / 队伍 / 计分 / 判题
- 公共首页
- 选手前台
- 高级 CIDR 池设计器
- 拖拽式复杂拓扑设计器

## 11. 文档替代关系

下列文档已不再作为当前主线设计依据：

- `docs/superpowers/specs/2026-06-24-admin-console-and-login-design.md`
- `docs/superpowers/specs/2026-06-25-admin-operations-console-refresh-design.md`
- `docs/superpowers/specs/2026-06-26-template-workbench-and-topology-editor-design.md`

下列计划文档也不再作为当前主线实施计划：

- `docs/superpowers/plans/2026-06-24-admin-console-and-login-implementation-plan.md`
- `docs/superpowers/plans/2026-06-25-admin-operations-console-refresh-plan.md`
- `docs/superpowers/plans/2026-06-25-template-versioning-and-topology-editor-foundation.md`
- `docs/superpowers/plans/2026-06-26-template-workbench-and-topology-editor-implementation-plan.md`

后续实现应以本设计文档、`PRODUCT.md`、`DESIGN.md` 以及其对应的新实施计划为准。
