# 腾讯云适配：账号与只读能力

开发分支：`codex/tencent-cloud`。基线是 master `2457a706`。

## 已接入平台

- 基础配置新增「腾讯云接入」。按明确地域、可用区、SecretId、SecretKey 验证并保存独立云账号。
- 使用 STS GetCallerIdentity 的主账号 AccountId，并从云端校验 CVM 可用区；不沿用阿里云凭据或默认配置。
- 腾讯云 SecretKey 使用 AES-256-GCM 加密，绑定厂商、账号、地域及 SecretId。密钥通过 `CLOUD_CREDENTIALS_ENCRYPTION_KEY` 注入，要求 64 位十六进制；未配置则在任何云请求/数据库写入前拒绝保存。
- 管理员可查询未启用账号、指定账号可售机型、公共/自定义镜像。目录查询按账号与地域隔离、不收录或接管费用。
- MCP 的保存入口保持二阶段确认与幂等审计；Web 保存同样留有脱敏审计。查询工具不返回凭据。
- 阿里云执行、回收、镜像及账单入口拒绝其它云厂商，避免把腾讯云凭据送往阿里云。

账号保存后 `isActive=false`。本批次没有开放腾讯云真实实例创建、编排、镜像导入/打包或费用同步。已有阿里云平台功能继续使用原配置。

## 已实现但尚未连接 worker

- 固定官方 `tencentcloudstack/tencentcloud` provider 1.83.34 的网络与单实例批次模块、渲染器。
- 50 个成员的离线模拟 plan，严格区分每台实例、平台用户与创建意图，并输出实例、系统盘及网络清单。
- 腾讯云 DescribeBillDetail 月费用只读客户端；分页不能按缓存 Total 提前结束，金额保留 Decimal 精度、退款和账号信息。

详情参见 `infra/opentofu/modules/tencentcloud-single-instance-batch/README.md` 与 `2026-10-09-tencent-billing-foundation.md`。

## 开放真实创建前必须完成

1. 在平台 API、镜像资产与模板编译中贯穿云账号选择；作业必须冻结厂商、主账号、地域、可用区与所有者。
2. 接入腾讯云 worker、网络生命周期、资源台账及逐 ID 回收核验。不能仅凭 OpenTofu destroy 成功关闭费用台账。
3. 处理官方 CVM provider 无可注入持久 ClientToken 的限制；断连/丢状态时先核验原账号已产生资源，未知结果禁止重建。网络资源同样需要创建意图与恢复证明。
4. 完成所有计费资源、镜像依赖磁盘与快照的来源链和清理。数据盘删除路径还需要验证与修复；首批模块仅允许系统盘镜像。
5. 为账单与异常数据加厂商维度，接入腾讯账单归属、日窗口拆分、退款和真实延迟对账；避免同 UID 跨云替换历史账单。
6. 在当前平台通过 MCP 执行最小受控创建/销毁测试，独立确认计费资源消失，并等待真实账单对齐。

## Docker 验证

所有自动测试和生产构建通过容器执行。IaC 验证固定 SHA-256、使用 `--network none`，不挂载真实凭据、云状态或平台数据库。

```sh
bash scripts/ci/verify-docker.sh
```

本机可以通过 `OPENTOFU_PROVIDER_MIRROR_HOST_PATH`、`TENCENTCLOUD_PROVIDER_MIRROR_HOST_PATH` 复用已校验 provider 缓存。容器重建仍需保留当前阿里云 provider 1.282.0-range.1、OpenTofu 1.13.1、现有工作空间卷和后台任务配置。

开发验证与腾讯云真实资源测试分别记录；离线 plan 不代表真实开通性能或费用回收已经完成。

## 官方依据

- [腾讯云地域与可用区](https://cloud.tencent.cn/document/product/213/6091)
- [产品地域查询](https://cloud.tencent.com/document/product/1596/77930)
- [产品可用区查询](https://cloud.tencent.com/document/product/1596/77929)
- [CVM 镜像查询](https://cloud.tencent.com/document/api/213/15715)
- [CVM provider 1.83.34](https://github.com/tencentcloudstack/terraform-provider-tencentcloud/releases/tag/v1.83.34)

用户要求优先杭州，若不可用则南京；最终地域和可用区必须以该账号的只读查询结果为准，不把其它产品的杭州接入或镜像 ID 当成 CVM 能力。
