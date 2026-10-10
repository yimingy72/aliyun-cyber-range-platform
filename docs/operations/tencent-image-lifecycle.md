# 腾讯云镜像生命周期适配

镜像 API 使用冻结的腾讯云 context ID、主账号 UID、地域和来源工作区。新打包产物与导入作业保存 `cloudProvider`；旧记录默认阿里云，不能据当前选中的账号改写来源。`CloudImageSnapshot.minimumSystemDiskSize` 保存云镜像给出的最小系统盘尺寸，未提供尺寸的生命周期更新保留既有值。

## 打包与回收

节点打包入口通过 `PackedImagesService.begin/submitTencentImage` 检查持久节点 ID、真实 CVM 标签归属和完整源盘清单。外部或共享磁盘阻止打包。CreateImage 提交完整 DataDiskIds、ForcePoweroff=false 和原子镜像来源标签；提交前持久化 intent。未知结果仅以 artifact 标签读取恢复，不再次 CreateImage。

镜像的全部 SnapshotSet、源 DiskId、新生成时间、PRIVATE_SNAPSHOT、CopyFromRemote=false、ShareReference=0 和外部镜像引用均参与核验。先保存 backing IDs 和每项费用账本再绑定 snapshot 标签；TagResources 每次最多十个资源和十个标签，并要求 FailedResources 为空。新打包镜像的 ImageSize 同步至最小系统盘字段。

删除镜像明确 DeleteBindedSnap=false，删除快照明确 DeleteBindImages=false。正在进行的云操作先等待终态；存在共享、复制或其它镜像引用时拒绝清理。每个资源确认消失后才释放相应账本，失败保留完整清单与已完成进度。

## COS 导入

腾讯导入仅使用平台创建且持久证明的专属私有 COS 桶。`CloudImageImportBucket` 保存创建 nonce、主 UID/AppId、原 context、地域、创建证据、marker、租约与创建者。并发由 activeSlot 唯一约束控制，已删除记录保留历史证明并清空 slot；未知创建保持 slot，不换名称或再次 PUT Bucket。

`ImageImportJob.managedBucketId` 用工作区与桶 ID 的复合 FK 关联，Prisma 同时限制跨工作区查询和嵌套关联，并禁止更改桶的创建身份字段。实际服务通过 `TENCENT_COS_BUCKETS` 注入；依赖不可用时拒绝导入，不发送创建请求。

上传签名绑定文件长度、内容类型、防覆盖和 job/owner/context 元数据。HEAD 必须匹配全部字段与源文件大小，之后持久化对象 ETag、作业、桶与冻结账号证明。敏感签名 URL 只用于授权上传响应或 ImportImage 请求体，不写入账本、恢复证明或日志。

腾讯 ImportImage 要求实际发行版 platform 与 osVersion。后端以 DescribeImportImageOs 的地域支持矩阵核验发行版、版本和架构，arm64 映射 arm_64，BIOS 映射 Legacy BIOS；不猜 OS 版本，不使用 Force 导入。ImportImage 使用原子 job 来源标签；网络超时保持 importing 并读取同一来源，禁止重复提交。

费用、镜像资产与快照清单同样先持久化再标记。只在 NORMAL 且全部来源核验通过后启用镜像；失败回收验证源盘和来源证据，并按镜像、快照逐项确认消失。临时 COS 对象删除后再次 HEAD 404 才设置回收时间，再交由桶服务判断是否空闲。

COS 官方账单已支持按桶资源 ID（完整桶名 + APPID）核验存储、流量、请求组件。平台专属桶的这些费用归平台公共开销；既有混用桶、未知或账号/地域汇总不能被估算归入平台。

## 官方依据

- [DescribeImages](https://cloud.tencent.com/document/product/213/15715)：已知 ID 与过滤器分离；完整 Offset/Limit 分页；按 SnapshotId 查询须完整读取 PRIVATE_IMAGE 后匹配 SnapshotSet。
- [CreateImage](https://cloud.tencent.com/document/api/213/16726)、[DeleteImages](https://cloud.tencent.com/document/api/213/15716)、[DeleteSnapshots](https://cloud.tencent.com/document/api/362/15645)：完整源盘、原子标签和非强制回收。
- [TagResources](https://cloud.tencent.com/document/product/651/72280)：QCS 六段式资源与部分失败结果。
- [ImportImage](https://cloud.tencent.com/document/product/213/15717)、[DescribeImportImageOs](https://cloud.tencent.com/document/product/213/15718)：发行版/版本/架构、COS 地址和原子来源标签。
- [COS 请求签名](https://cloud.tencent.com/document/product/436/7778)、[PUT Bucket](https://cloud.tencent.com/document/product/436/7738)：签名协议、私有桶和创建时标签。
- [COS 账单](https://cloud.tencent.com/document/product/436/30357?lang=zh)、[计费计量问题](https://intl.cloud.tencent.com/zh/document/product/436/10373?lang=zh)：按完整桶资源 ID 分账。

当前验证通过 Docker 生产编译、synthetic SDK 响应和隔离 PostgreSQL；真实 CAM/COS 权限、云上创建、导入文件和资源回收尚未进行。
