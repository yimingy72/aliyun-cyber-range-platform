# alicloud-vpc-single-ecs

最小阿里云综合靶场模块，当前只创建一套单 VPC、单 vSwitch、单安全组、单 ECS 主机的基础靶场骨架，供后续扩展为多机综合渗透模板。

## 创建资源

- `alicloud_vpc`
- `alicloud_vswitch`
- `alicloud_security_group`
- `alicloud_security_group_rule`
- `alicloud_instance`

## 关键输入

- `resource_name_prefix`
- `zone_id`
- `vpc_cidr`
- `vswitch_cidr`
- `instance_type`
- `image_id`
- `instance_password`

## 关键输出

- `vpc_id`
- `vswitch_id`
- `security_group_id`
- `instance_id`
- `private_ip`
- `public_ip`
- `access_entry`

## 本地静态校验

```bash
pnpm iac:validate
```
