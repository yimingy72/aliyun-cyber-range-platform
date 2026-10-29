# 腾讯云 / 阿里云适配审查（2026-10-29）

## 范围与证据

逐模块检查 Web、HTTP API、MCP、账号/资源归属、后台任务、OpenTofu 和已有回归用例。
“已实现”指存在独立腾讯适配及离线回归覆盖，不代表本次执行了真实云验收。
本次不使用生产凭据、不创建/删除真实云资源、不部署、不合并。
容器验证由仓库 GitHub Actions `Container verification` 执行；最终状态以本 PR 的准确提交检查为准。

## 能力矩阵

| 功能 | 阿里云 | 腾讯云 | 处理 / 边界 |
| --- | --- | --- | --- |
| 账号绑定、工作空间切换、地域/可用区核验 | 已实现 | 已实现 | 厂商+主账号隔离；切换不重定向已受理任务的冻结账号。 |
| 机型目录与可售检查 | 已实现 | 已实现 | 公开执行检查只报告平台可部署的 x86 机型，原始账号机型查询保留完整目录。 |
| 公共/自定义镜像同步、收录、标签、启停/发布、删除 | 已实现 | 已实现 | 保留腾讯入口，不因适配差异隐藏整个镜像中心。 |
| 本地系统镜像导入 | QCOW2/RAW/VHD | QCOW2/RAW/VHD/**VMDK** | 本次补 VMDK；禁止把此格式发送给阿里适配器。 |
| 导入临时存储 | OSS | 私有托管 COS | 腾讯单 PUT 上限 5 GiB；预签名下载授权上限 24h，配置不兼容时在创建桶/任务前拒绝。 |
| 导入失败/未知结果恢复 | 已实现 | 已实现并修正 | 有官方 RequestId 的明确拒绝允许显式重试；超时/内部错误/缺回执/未知结果只核验原来源，不盲目重新创建。 |
| 实例打包镜像、来源快照清理 | 已实现 | 已实现 | 固定原实例/账号/地域和来源证明；不强制删除共享或外部快照。 |
| 单实例/批次创建、重试、回收 | 已实现 | 已实现（OpenTofu路径） | 腾讯密码、主机名、磁盘大小、镜像 OS 在共享网络创建前校验；native 旧路径不支持腾讯。 |
| 模板编辑、保存、发布、复制 | 已实现 | 已实现 | 本次移除各层阿里专用密码校验，使用真实厂商及镜像 OS；不注入阿里镜像/机型默认值。 |
| 编排创建、拓扑应用、重试创建 | 已实现 | 适配器存在，**平台安全开关控制** | `TENCENTCLOUD_RANGE_NAT_EXECUTION_ENABLED=1` 才开放；缺失能力字段时腾讯前端拒绝开放。不是腾讯云不支持。 |
| 编排销毁、失败销毁重试 | 已实现 | 已实现 | 上述创建开关关闭时仍保留清理/回收，防止资源无法释放。 |
| CVM/ECS 开关机、重启、VNC | 已实现 | 已实现 | 腾讯使用独立 CVM API；控制前校验冻结资源，VNC 限官方受信地址。 |
| VPC/子网/路由/安全组/ACL/ENI/辅助IP | 已实现 | 已实现 | 使用腾讯独立 module、参数和配额；额外网卡的客体配置仍依赖镜像/初始化脚本。 |
| NAT/EIP/SNAT/DNAT | 已实现 | 适配器存在，随编排安全开关控制 | 当前模型仅 TCP/UDP DNAT；腾讯 DNAT 网段要求显式 SNAT，不静默放宽出网隔离。 |
| DNS固定脚本应用及回读 | Windows适配 | Windows TAT适配 | Linux客体 DNS 管理尚未实现；不是腾讯 TAT 服务不支持 Linux。 |
| 初始化脚本、运行拓扑更新 | 已实现 | 已实现 | 腾讯启动脚本 16 KiB 限额；保留运行主机的镜像、密码、机型、NIC及已部署 userdata，校验精确预览版本。 |
| 网络诊断、巡检、来源核验与确认回收 | 已实现 | 已实现 | 标签只用于查找候选，不单独作为删除授权；未知归属/丢失完整状态时保持失败关闭。 |
| 自动到期清理 | 已实现 | 已实现 | CVM 原生 ActionTimer 只终止 CVM；NAT/EIP 等仍依赖 worker 回收，不能声称全账单自动结清。 |
| 官方账单、归属台账、同步/导出 | 已实现 | 国内 CNY已实现 | 腾讯非 CNY响应明确拒绝且保留旧账单；国际站/多币种适配未实现，不能仅凭UIN推断并隐藏整个账单模块。 |
| 专用已有桶费用声明/新建持久 OSS桶 | 已实现 | 阿里专属入口不可用 | 腾讯托管导入 COS费用已有来源证明；任意已有 COS桶认领尚未实现，不能复用 OSS语义。 |
| 墨攻源目录/云镜像ID收录 | 阿里来源匹配/绑定 | 不可用 | `m-*`源镜像不是腾讯`img-*`镜像；隐藏入口，HTTP/MCP在确认/任务/写入前返回`CLOUD_PROVIDER_UNSUPPORTED`。 |
| 旧全局进程环境云配置 | 阿里兼容路径 | 不可用 | 腾讯使用账号绑定/工作空间选择，不把腾讯密钥写入阿里全局配置。 |
| 用户、权限、普通平台容器目录记录 | 工作空间隔离 | 工作空间隔离 | 保留通用能力；容器运行部署不是现有平台能力（两云均无）。 |
| ARM/共享或市场镜像/隐式数据盘部署 | 依现有适配边界 | 当前执行适配不开放 | 腾讯云产品本身支持相关能力；需完整机型、镜像、盘归属与回收设计后再加，不能盲目复用阿里流程。 |
| 镜像跨区复制/导出/分享、分片上传 | 未暴露通用产品流程 | 未暴露通用产品流程 | 腾讯提供相关API，但本次没有把它们伪装成已验证的平台能力。 |

## 本次修复

- 前端按能力隐藏编排创建/应用/创建重试，同时保留模板编辑和回收；实际镜像入口继续使用已适配的统一页面，不启用旧的只读腾讯页面。
- 创建对话框在工作空间/活动账号变化时清空选择并使旧请求失效，包含 A→B→A、延迟返回和重复操作。
- HTTP/MCP明确拦截腾讯调用阿里 OSS费用声明、墨攻目录和旧全局配置。新增可机读`ossBillingBinding`、`mogongCatalog`能力。
- 修复旧`POST /admin/ranges`未检查能力、且省略厂商时把腾讯模板记录成阿里的漏洞；以可信模板和工作空间绑定厂商。
- 统一腾讯密码策略，区分Linux/Windows；预检索引化主机名、系统盘和实时镜像OS，Windows冻结为`Administrator`而非陈旧缓存推断的`root`。
- 增加腾讯VMDK导入、明确拒绝的安全重试、COS单次上传/授权时长前置边界，以及可执行x86机型检查。

## 回归与仍需真实验收的项目

新增/扩展用例覆盖两云密码与格式、生成密码、Windows主机名、不可用机型、重复失败/重试、未知云结果不重提、账号/地域来源变化、禁用路由、能力契约和切换过期响应。
既有容器总验收包含 API/MCP/Web/共享包测试、构建、隔离数据库回归、固定版本腾讯/阿里 provider构建和 OpenTofu离线计划。

真实云验收仍需另行授权：腾讯 NAT/EIP中断恢复及最终费用回收、TAT客体回读、真实导入镜像兼容性、各地域权限/库存/配额。保持现有NAT安全开关，不将模拟测试当作真实云成功证据。

## 关键代码与官方依据

- 账号/能力：`apps/api/src/admin/cloud-workspaces.service.ts`、`cloud-account-contexts.service.ts`；边界：`apps/api/src/auth/cloud-provider-policy.ts`。
- 运行/恢复：`single-instances.service.ts`、`range-instances.service.ts`、`apps/api/src/provisioning/provisioning-worker.service.ts`、腾讯 renderers 和 `infra/opentofu/modules/tencentcloud-*`。
- 镜像/费用：`image-imports.service.ts`、`tencent-image-rpc.ts`、`tencent-cos-client.ts`、`tencent-billing-client.ts`；Web：`cloud-execution-policy.ts`及对应管理页面；MCP统一走同一HTTP服务。
- [CVM LoginSettings 创建密码](https://cloud.tencent.com/document/api/213/15753#LoginSettings)、[RunInstances 主机名](https://cloud.tencent.com/document/api/213/15730)、[ImportImage 格式/错误](https://cloud.tencent.com/document/api/213/15717)、[COS简单上传](https://cloud.tencent.cn/document/product/436/14113)。创建密码按LoginSettings专属字符集合处理，不把控制台重置密码的不同规则混用。
