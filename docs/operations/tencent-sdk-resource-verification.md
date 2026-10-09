# 腾讯云 SDK 核验与控制边界

SDK 不创建 CVM、CBS、网络或镜像。新实例及网络创建、正常销毁由冻结工作区的 OpenTofu 执行；SDK 负责只读事实核验、实例控制和有本次创建证明的实例应急回收。

`admin/tencent-cloud-resources.ts` 的账户参数为 `SystemCloudAccountContext`。它要求 `provider=tencent_cloud`、已核验 UID、context ID 和地域，不接受阿里云账号或当前默认账号回退。所有结果中的 `evidence` 保存 provider、UID、context、地域、查询 action、全部请求 ID 和观测时间，不保存凭据或原始响应。

查询接口：

- `describeTencentInstances(account, { instanceIds?, tags?, vpcId? })` 返回既有 `NormalizedInstanceDetail`，腾讯 `RUNNING/STOPPED` 对应 `Running/Stopped`。
- `describeTencentResourceInventory(account, kind, { ids?, tags?, vpcId?, instanceId?, diskIds? })` 返回明确物理 ID、白名单标签、附件及查询证据。kind 支持 ecs、disk、snapshot、vpc、vswitch、security_group、network_acl、eni、nat、eip。
- 已知 ID 查询也完整读取 Offset/Limit 分页；总数变化、重复 ID、非请求 ID、缺少 RequestId、缺页或超出 100 页均失败，不能被解释为资源不存在。
- `network_acl` 官方过滤器没有标签条件，只用已知 ACL ID 或已冻结 VPC ID；`nat` 只有 tag-key，用该键完整分页后筛选确切值。`snapshot` 官方过滤器没有标签条件，只用 SnapshotIds 或已知源 disk-id（每次最多十个磁盘）。
- CBS 归属只来自 fenced OpenTofu 状态保存的 disk-* ID；标签匹配不能接管外部或共享云盘费用。系统盘、数据盘和 CVM ID 分开保存。

腾讯节点控制先校验持久资源 ID、冻结 provider/UID/context/region 及真实 owner/批次/节点标签。StartInstances 只接受已观测 STOPPED，StopInstances 和 RebootInstances 只接受 RUNNING，使用 SOFT；关机不等同于免费或销毁。响应仅为 accepted，须查询后续终态。VNC 只通过访问响应返回官方控制台链接，不落入日志、台账或资源快照。

`resetTencentStoppedInstancePassword(account, instance, hostKey, password, userName?)` 同样要求持久节点 ID 和真实归属，只对已观测 STOPPED 实例调用 ResetInstancesPassword，ForceStop=false；没有新增公网接口或隐式关机。

应急 TerminateInstances 需要原始 `opentofuCreateJobId`、该 member 的实际 create/retry 作业、冻结创建意图、账户与 owner、明确本次物理 ID及完整磁盘清单。调用方必须先证实本次 apply 已提交（manifest/pending marker/known ID）；云标签本身不证明提交。只允许 POSTPAID_BY_HOUR；已知所属 CBS 必须 DeleteWithInstance=true，外部附件必须明确 DeleteWithInstance=false，不释放 EIP 或包年包月盘。未知写结果不自动重发。两个完整空 CVM 查询轮次、空 CBS 和所有既有成员账本中 CVM/CBS/EIP/NAT 明确 ID 的消失核验后才允许上层完成回收；任何未知结果保留状态、恢复材料和费用账本。

资源对账仅记录云端证据及漂移。未满足持久创建、冻结账号、资源 ID 和现有费用账本证明时，不接管资源、费用或重写实例状态。快照由已保存 provider/UID/region 账本的确切 ID核验，无法用 SDK 标签发现未知快照。

## 官方参数核验（2026-10-10）

| 能力 | 官方文档 | 采用的约束 |
| --- | --- | --- |
| CVM 查询 | [DescribeInstances](https://cloud.tencent.cn/document/product/213/15728) | InstanceIds 与 Filters 分离，InstanceSet/TotalCount、Offset/Limit，tag:key |
| CVM 开机 | [StartInstances](https://cloud.tencent.com/document/api/213/15735) | InstanceIds，STOPPED，异步 RequestId |
| CVM 关机 | [StopInstances](https://cloud.tencent.com/document/api/213/15743) | SOFT、KEEP_CHARGING、RUNNING |
| CVM 重启 | [RebootInstances](https://cloud.tencent.cn/document/api/213/15742) | SOFT、RUNNING，查询终态 |
| VNC | [DescribeInstanceVncUrl](https://cloud.tencent.com/document/product/213/18150) | InstanceVncUrl，官方 img.qcloud.com 控制台，敏感输出 |
| 密码 | [ResetInstancesPassword](https://cloud.tencent.com/document/api/213/15736) | InstanceIds、Password、UserName、ForceStop=false |
| CVM 回收 | [TerminateInstances](https://cloud.tencent.com.cn/document/api/213/15723) | 按量实例；不释放 EIP 或包年盘；查询消失 |
| CBS | [DescribeDisks](https://cloud.tencent.com/document/api/362/16315) | disk-*、instance-id、DiskUsage、DeleteWithInstance、Shareable |
| 快照 | [DescribeSnapshots](https://cloud.tencent.cn/document/product/362/15647) | SnapshotIds 或 disk-id，SnapshotSet/TotalCount，无标签过滤器 |
| VPC | [DescribeVpcs](https://cloud.tencent.com/document/product/215/15778) | VpcIds、VpcSet、字符串 Offset/Limit |
| 子网 | [DescribeSubnets](https://cloud.tencent.com/document/api/215/15784) | SubnetIds、SubnetSet、字符串 Offset/Limit |
| 安全组 | [DescribeSecurityGroups](https://cloud.tencent.com/document/api/215/15808) | SecurityGroupIds、SecurityGroupSet、TagSet |
| ACL | [DescribeNetworkAcls](https://cloud.tencent.com/document/product/215/42160) | NetworkAclIds 或 vpc-id，无标签过滤器 |
| ENI | [DescribeNetworkInterfaces](https://cloud.tencent.com/document/api/215/15817) | NetworkInterfaceIds、NetworkInterfaceSet、Attachment |
| NAT | [DescribeNatGateways](https://cloud.tencent.com/document/product/215/36034) | NatGatewayIds、NatGatewaySet，标签仅 tag-key |
| EIP | [DescribeAddresses](https://cloud.tencent.com/document/api/215/16702) | AddressIds，已知 ID 也必须完整分页 |

验证范围为 Docker 生产编译和 synthetic fixtures；未调用真实腾讯云接口、平台或数据库，真实 CAM 权限、库存、地域和返回差异尚待授权环境验证。
