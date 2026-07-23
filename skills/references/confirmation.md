# 危险操作确认

仅在用户已经明确要求某项写操作后使用本文件。用户授权、MCP 输入 schema 和平台服务端确认是三个独立条件，不能互相替代。

## 调用前

1. 用只读工具解析准确目标 ID，并检查资源状态、可见性和权限。
2. 展示操作摘要：操作类型、目标 ID、影响范围、不可逆后果和资源成本/凭据影响。
3. 对入口 Skill 标为危险的操作，等待用户明确确认后执行。
4. 参数、目标、范围或到期时间改变时，重新展示摘要并获得新确认。

## 平台二阶段确认

平台可能直接接受写操作，也可能返回 `CONFIRMATION_REQUIRED`、`confirmationId` 和可选 `idempotencyKey`。

```text
用户明确授权
  → 首次 MCP 调用
  → 若直接接受：跟踪资源/作业终态
  → 若返回 CONFIRMATION_REQUIRED：核对摘要
       → 用户再次确认
       → 相同业务参数 + 返回的 confirmationId 再次调用
```

- 只使用服务端实际返回的 `confirmationId`；不要猜测、复用或跨资源使用。
- schema 或响应要求幂等键时，同一业务请求保持同一 `idempotencyKey`；任何参数变化都使用新键。
- 服务端未要求确认时，不编造 `confirmationId`，也不阻塞用户等待虚构确认。
- 确认可能失效；二次调用失败时重新发起预确认，不假设确认的有效期或复用旧 ID。

## 镜像写操作

`platform_image_collect`、`platform_image_rename`、`platform_image_enable`、`platform_image_disable`、`platform_image_publish`、`platform_image_unpublish` 和 `platform_image_remove` 都是危险操作。每一项均先取得用户确认；服务端返回确认要求时再走本文件的二阶段调用。

## 拓扑编辑与编排实例

用户明确要求创建模板、编辑模板信息、检测并保存模板拓扑或保存实例拓扑时，`range_template_create`、`range_template_update`、`range_template_topology_detect_and_save`、`range_instance_topology_save` 不额外要求人工二次确认；但 MCP 必须通过完整拓扑编译校验后才会保存。

发布到平台、取消发布、删除模板、应用实例变更、同步实例配置回模板、实例重试、节点开机/关机/重启、打包镜像、销毁实例、删除创建失败记录始终需要危险操作确认。VNC 与访问凭据不改变资源状态，但必须符合敏感输出规则。
