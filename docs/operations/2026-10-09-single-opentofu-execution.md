# 单实例 OpenTofu 执行与启动、回收性能

## 执行方式

新单实例固定 `executionBackend=opentofu`。API 校验镜像、规格、到期时间和账号身份后入队；worker 先获取数据库批次租约，再认领成员任务。一个提交使用一个按 batch/owner/context UID/region/zone/profile 固定的工作区，`for_each` 以平台实例 ID 区分 ECS。公共网络已有 profile 复用，首次初始化仍受跨进程控制锁保护。

正常创建和销毁通过真实 OpenTofu provider，不通过原来的 native create。重启、VNC、镜像打包、状态查询仍使用对应云 API。旧 API 实例保留原回收路径；不把旧资源冒充新 OpenTofu 状态。

单台销毁使用同批状态的目标计划，仅删除指定成员；执行前读取 JSON 计划，拒绝变更其他成员或共享网络。失败创建保留已确认成功的成员，仅回收未完成成员。丢失状态或中断文件存在时先恢复，不盲目重新创建。未被状态跟踪的资源仅在 exact owner/batch/RangeInstanceId/账号/地域证明后做明确标记的应急回收。

## 提速措施

- 容器启动时校验 provider ZIP 的 SHA256，并原子发布只读的预解压镜像；OpenTofu init 直接链接 provider，避免每个工作区重复解压。不启用并发安全性不足的共享 plugin cache。
- plan 内含配置校验；运行链移除重复的独立 validate，CI 持续验证全部模块。保留 init、计划检查、状态锁和软中断落盘。
- API 将只读规格预检移出全局控制锁，入锁后重新校验账号、镜像和到期时间；网络返回后再次核验来源。首次网络初始化仍是一次成本。
- 待执行任务采用 FIFO keyset、有界轻量数据库查询和索引，过期查询下推数据库；不再每轮加载全部历史和凭据 JSON。
- 状态刷新一次查询后结束，未就绪则延迟 2 秒重新入队，释放槽位；编排销毁后的独立资源核验最多 4 个请求并行，EIP 去重，ECS 精确查询每页最多 100 个 ID，异常响应不能作为销毁证明。

## 性能口径

[阿里云 provider 1.282.0](https://github.com/aliyun/terraform-provider-alicloud/blob/v1.282.0/alicloud/resource_alicloud_instance.go) 本身也使用 RunInstances，但 ECS 创建有固定 10 秒初始状态等待。这里优化平台的初始化、队列和执行成本，不能把 HTTP 受理速度当作云实例可用速度。

同平台、同镜像、2c4g、40GiB、两台实例的旧 API 基线：入队到两台 running 且具有公网 IP 为 5.983 秒；包括首次网络准备为 30.219 秒；销毁请求到平台完成核验为 5.994 秒。时间来自服务端持久化时间和随后独立 MCP 云不存在核验，首次客户端观察时间单独记录。

受控测试只创建临时验证资源，每轮立即回收 ECS；本轮新共享网络在全部阶段结束后按预登记范围回收，旧网络和用户资源保持原状。结果不代表大量用户并发下的云吞吐或额度保证。
