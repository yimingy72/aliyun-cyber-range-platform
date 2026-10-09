# OpenTofu 升级与任务并发优化

## 版本与兼容性

2026-10-09 核对 GitHub 最新稳定版本为 [OpenTofu 1.13.1](https://github.com/opentofu/opentofu/releases/tag/v1.13.1)，发布于 2026-10-01；平台从 1.12.3 升级到 1.13.1。API、worker、CI、部署包和开发脚本的默认版本同时更新。复用 CI 基础镜像时也会重新复制指定版本的二进制，避免验证误用旧版本。

[1.13 升级说明](https://github.com/opentofu/opentofu/blob/v1.13/CHANGELOG.md) 中可能影响配置的变化包括移除 WinRM、`base64gzip` 输出压缩字节变化和远程 SSH 解析更加严格。当前平台模块不使用 WinRM、`base64gzip` 或远程 SSH provisioner；运行于 Linux amd64 容器。阿里云 provider mirror 保持 1.282.0，不同时变更 provider。

1.13.1 修复 ephemeral 资源相关的 plan JSON 展示和 apply 输出求值；1.13 也包含长 `depends_on` 链的规划性能改进。平台继续通过新的 plan 执行 apply，不复用其他版本的旧 plan。

## 安全边界

默认每个进程允许 2 个编排任务、3 个单实例批次并行，单实例批次内部保持最多 10 个成员并行。任务的数据库原子认领、同实例/批次互斥、owner 和云账号隔离、心跳及失败清理逻辑保持生效。并发配置按进程计算，横向增加 worker 时需计算总容量。

可用区选型仅在一次调度内去重重复询价，有界并行查询候选价格，保持候选原序及最低价格策略。不同云账号和作业之间不共享询价缓存。

单实例开通仍走阿里云 RunInstances API；共享单实例网络和多实例编排由 OpenTofu 执行。

## 验证与回滚

- 使用 Docker 中真实 OpenTofu 1.12.3 生成无云资源的 `terraform_data` 状态，1.13.1 读取后 plan 为 `no-op`，再执行更新、output 和 destroy。此状态作为 iac-runner 回归 fixture 留存，不包含云凭据或实际资源。
- 真实 1.13.1 的软中断测试验证超时后仍落盘部分状态，并可销毁；不关闭 stdio 或强杀来缩短等待。
- 使用阿里云 provider 1.282.0 镜像缓存完成模块 fmt、init 和 validate。
- 并发与查询性能通过容器中的受控慢后端验证，不产生新的收费云资源；耗时结果不代表阿里云实测开通时间。

升级当前运行容器前，应通过平台确认无在途资源任务，备份 OpenTofu 工作区状态卷，并保留旧 API/worker 镜像。回滚遵循 [官方升级指南](https://opentofu.org/docs/intro/upgrading/)：备份当前状态、切回旧镜像，执行 init 和 plan，先确认无意外资源变更。不要直接拿旧状态覆盖已发生新资源操作的状态。
