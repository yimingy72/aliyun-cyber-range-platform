# 镜像与快照费用生命周期审查（2026-10-09）

本轮仅使用 Docker 构建、隔离 PostgreSQL 与云 API 故障夹具；未创建、导入、导出或删除现有阿里云资源。

## 已确认问题及修复

1. **导入请求成功但响应丢失可能丢失云镜像**：旧代码收到超时即标记 failed/imageId=null，上传过期后取消任务并删 OSS，worker 不再按来源查找已创建镜像。现在提交前持久化 importing 意图，固定 ClientToken/计费起点，未知结果按唯一来源标签、owner、账号上下文恢复；未确认前不再次 ImportImage，不删除恢复所需 OSS。明确参数/权限/限流拒绝才允许用户显式重试。
2. **导入失败只删除镜像，遗漏真实 backing snapshots**：旧代码 Force=true DeleteImage 后立即标记完成、只释放 imageId 对应台账。现在冻结账号/地域/Bucket，先记录所有镜像绑定快照，建立匹配台账，Force=false 删除镜像及无其它引用的已证明自有快照。每个资源查询确认消失后才释放自身台账，持久化逐个删除进度，worker 重启可继续。
3. **错误和不完整查询可被当成不存在**：旧导入 RPC 不检查 HTTP 200 业务错误，DescribeImages 不校验返回身份/数量/分页，删除不核验。现在统一检查业务结果，查询覆盖全部状态并验证精确 ID/分页/重复结果。残缺结果、共享引用或旧清理记录缺少快照清单时保留材料，不能标记全部回收。
4. **多个进程可能同时提交或清理同一导入**：现在使用数据库租约，云请求前续租、状态写入验证持有者与有效期；另一个 worker 接管后旧进程不能继续云操作或写入成功。上传、轮询、失败重试和终态清理共享租约。
5. **账本依赖云标签成功且跨账号校验不足**：打包和导入先保存精确快照身份，在来源核验后先写全部账本再写云标签。标签写入失败不丢失计费身份；导入台账增加唯一任务标记，拒绝覆盖其它账号/任务归属，释放严格限定账号、地域、资源类型/ID及任务标记。
6. **同源未确认打包可被重复提交**：打包来源登记在跨进程控制锁内检查，同一 ECS 有 pending/creating/deleting 打包时拒绝新的打包请求，要求先核验原任务。

## 快照何时保留、何时删除

平台当前执行 CreateImage/ImportImage，没有 ExportImage 代码路径。CreateImage 从实例制作镜像会为每块磁盘生成一个新快照。保留可用于创建 ECS 的云镜像时，其依赖快照需要保留并持续产生存储费用；释放源 ECS 不代表删除这些快照。

云镜像不再需要时，先删除镜像，再删除无其它镜像/磁盘引用且来源证明充分的自有快照。平台完整打包回收要求显式 `deleteOwnedSnapshots: true`。移出平台目录或默认只删除云镜像会保留快照及其费用记录。不能自动删除外部、共享、来源不明快照。

另外通过阿里云 ExportImage 导出到 OSS 后，OSS 副本有存储、请求、下载流量费用。确认导出文件可用且原云镜像已不再需要，才删除原镜像及依赖快照；OSS 文件也应按实际保留需求另行清理。导出本身不会证明这些资源已回收。

## 验证与边界

- Docker 镜像 `range-snapshot-cost-guard:validation`：Prisma 生成、运行时包与 API TypeScript 构建通过。
- 8 套相关 API 服务/HTTP 测试、原打包恢复测试与隔离 PostgreSQL 真实租约/旧写入者隔离共 142 项通过。40 个数据库迁移在隔离 PostgreSQL 完整应用。
- 覆盖：未知响应恢复、不重复创建、明确拒绝显式重试、多盘、标签失败、空查询/残缺分页、HTTP 200 业务失败、跨账号/地域、原 Bucket 固定、共享/磁盘引用、删除响应成功但资源仍在、部分成功重启续清理、重复清理、租约过期、旧清理缺少证明。
- 云 API 长期不可用、身份/依赖证明缺失时保持未确认/清理未完成与台账，不声称零费用或自动越权删除。旧版本已经丢失来源证明的孤儿资源仍需要单独核验；本次未对现有云资源做破坏性清理。

## 显式网页回收入口

云上自定义镜像删除弹窗现在默认只删镜像，并明确告知快照继续计费。对于持久化来源记录完整的新平台打包镜像，可主动选择同时回收所属快照；旧镜像、外部镜像、不完整或仍在创建的来源不显示此选项。服务端原有所有权、云账号和引用校验不变。

只删云镜像后，未完成回收的所属快照仍以“快照待回收”保留在目录中，用户可以再次打开同一目标回收；部分失败保持弹窗中的选择和错误信息。前端只有在收到 `removed: true` 且 `status: deleted` 时才把完整回收当成成功。

Docker 镜像 `range-snapshot-cleanup-ui:validation` 的 API 和 Web 生产构建通过；目录/HTTP 78 项、网页及 API 请求辅助函数 51 项测试通过。没有部署本次 UI，未操作实时云资源；浏览器视觉验证由主会话集成部署后完成。

## 官方依据

- [CreateImage](https://www.alibabacloud.com/help/en/ecs/developer-reference/api-ecs-2014-05-26-createimage)：异步创建，实例各磁盘产生快照，ClientToken 幂等。
- [ImportImage](https://www.alibabacloud.com/help/zh/ecs/developer-reference/api-ecs-2014-05-26-importimage)：导入及 ClientToken。
- [DeleteImage](https://www.alibabacloud.com/help/en/ecs/developer-reference/api-ecs-2014-05-26-deleteimage)：Force=false 保留云端依赖保护。
- [DeleteSnapshot](https://help.aliyun.com/en/ecs/developer-reference/api-ecs-2014-05-26-deletesnapshot)：被镜像引用时先删除镜像；磁盘使用时不强制删除。
- [镜像 FAQ](https://www.alibabacloud.com/help/en/ecs/faq-about-image-lifecycle)：镜像引用的快照即使过期仍保留并持续计费。
- [ExportImage 与 OSS 费用](https://help.aliyun.com/en/ecs/user-guide/export-a-custom-image)：OSS 存储、请求和外网下载费用。
