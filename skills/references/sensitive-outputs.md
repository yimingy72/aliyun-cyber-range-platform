# 敏感输出

将以下内容视为秘密：密码、带凭据的 SSH 连接串、VNC URL、AccessKey、Token，以及含密码的 CSV 行。

## 敏感工具

- `range_instance_get_access`
- `range_instance_node_open_vnc`
- `single_instance_get_access`
- `single_instance_open_vnc`
- `single_instance_batch_export_csv`
- 返回或接收默认密码时的 `single_instance_pack_image`、`range_instance_node_pack_image`
- `admin_user_create` 和 `admin_user_reset_password`
- `cloud_config_update`、`cloud_account_bind`、`tencent_cloud_account_save`、`tencent_cloud_region_list`
- `range_template_get`、`range_template_topology_detect_and_save` 和模板写操作不会回显 `customPassword`；`range_instance_get` 也会移除运行凭据。返回的任何访问串仍须按秘密处理，不因来自只读工具而可传播。不要把这些字段当作可读取的访问数据。

## 规则

1. 仅当用户明确要求访问数据，或明确授权关联的凭据变更时，才调用敏感工具。
2. 仅返回所需的最小秘密。不要在摘要、任务标题、文件名、日志、审计说明或后续消息中重复它。
3. 不要在对话中粘贴凭据 CSV 内容。仅当用户明确要求导出时，返回其存在、行数和安全交付路径。
4. 不要把秘密发送给其他 Agent、外部服务或无关工具。
5. 若响应意外包含秘密，在面向用户的摘要中脱敏，并继续报告非敏感状态。
6. 不要在 Skill 创建的文件中缓存 VNC URL 或密码。
