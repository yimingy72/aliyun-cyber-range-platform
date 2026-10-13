# alicloud-enterprise-range

第一版企业网络型阿里云综合靶场骨架模块。

当前目标不是一次性覆盖完整企业网络，而是先把以下固定拓扑能力做成稳定的 OpenTofu 入口：

- 单队一套独立 VPC
- 多网络区 / 多 vSwitch
- 多台 ECS
- DMZ 入口机 + 独立 EIP
- 固定私网地址由调用方显式传入

## 当前创建资源

- `alicloud_vpc`
- `alicloud_vswitch` (`dmz / office / server`)
- `alicloud_security_group`
- `alicloud_security_group_rule`
- `alicloud_instance` (`dmz / office / server`)
- `alicloud_eip_address`
- `alicloud_eip_association`

## 关键输入

- `resource_name_prefix`
- `zone_id`
- `vpc_cidr`
- `dmz_cidr`
- `office_cidr`
- `server_cidr`
- `dmz_private_ip`
- `office_private_ip`
- `server_private_ip`
- `instance_type`
- `image_id`
- `instance_password`

## 关键输出

- `vpc_id`
- `subnet_ids`
- `host_ids`
- `public_entry`
- `resource_summary`

## 说明

- 这不是最终完整靶场模板，只是第一版企业网络型骨架
- 后续可继续扩展到更多网络区、更多主机角色和更多云资源类型
- 当前本地静态校验入口是 `pnpm iac:validate`

平台到期时间 `T` 与 ECS 云端兜底期限分开。Worker 在初始化及主机依赖的网络准备完成后持久化主机阶段基准 `C`，冻结 `ceilMinute(max(T+5min, C+32min))`，再执行主机计划。已有主机的 `auto_release_time` 不随普通拓扑修改清空或延长；新增节点使用原编排的 `T` 和自己的创建阶段基准。期限属于运行库存，不写入可复用模板。

只有 `DescribeInstances` 对准确主机 ID 返回相同 `AutoReleaseTime`，才标记兜底配置已核验。读取失败、未配置或不匹配会保留主机与待核验状态，平台继续按原 `T` 回收；不会据此重新创建主机。云端兜底不能代替 EIP、NAT、网卡、规则等平台完整清理。
