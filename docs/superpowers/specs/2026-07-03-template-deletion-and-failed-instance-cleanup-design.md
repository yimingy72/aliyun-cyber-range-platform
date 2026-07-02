# Template Deletion And Failed Instance Cleanup Design

## Goal

调整模板删除与实例清理语义，满足两类后台操作：

1. 模板只有在其关联实例全部处于 `destroyed` 状态时才允许删除。
2. 模板删除后，已销毁实例的历史记录仍然保留且可展示原模板信息。
3. `create_failed` 的实例在“靶场实例”页支持直接删除记录。

## Current State

- 当前模板删除由 `DELETE /admin/scenarios/:id` 直接触发数据库删除。
- 当模板仍被 `RangeInstance.templateId` 引用时，数据库外键会阻止删除。
- 现有修复已经把“存在非 destroyed 实例时”从 `500` 调整为后端拦截，但“已销毁实例历史要保留”仍未正式落成。
- `RangeInstance` 当前强依赖 `templateId` 非空，且历史展示主要依赖实时模板记录。
- “靶场实例”页当前只对 `running` / `destroy_failed` 提供生命周期操作，不支持删除 `create_failed` 记录。

## Confirmed Product Rules

### Template deletion

- 如果模板关联任意 `非 destroyed` 实例：
  - 后端拒绝删除，返回 `409 Conflict`
  - 前端删除弹窗提示必须先销毁运行中或未终态实例
- 如果模板关联实例全部为 `destroyed`：
  - 允许删除模板
  - 模板从“靶场编排”中彻底移除
  - 已销毁实例历史仍保留
  - 历史实例仍能展示模板名称、slug、版本等关键信息

### Failed instance deletion

- 仅 `create_failed` 实例支持直接删除记录
- 删除记录不触发云销毁动作
- 删除后实例从“靶场实例”列表中移除

## Recommended Architecture

采用“模板物理删除 + 实例快照保留”的方式，而不是软删除模板。

原因：

- 用户已经明确要求：只有全部关联实例都 `destroyed` 时，模板才允许删除。
- 删除后模板不应继续出现在编排列表，因此不需要保留一个“隐藏模板”状态。
- 历史实例需要保留模板展示信息，但这类信息可以固化到实例快照中，不必继续依赖实时模板表。

## Data Model Changes

### RangeInstance additions

为 `RangeInstance` 增加模板快照字段，用于模板删除后继续展示历史：

- `templateNameSnapshot`
- `templateSlugSnapshot`
- `templateVersionSnapshot`
- `templateModulePathSnapshot`
- `templateBlueprintSnapshot`（可选，存最小拓扑摘要或完整编排快照）

### RangeInstance relation change

- `RangeInstance.templateId` 改为可空
- 外键从 `onDelete: Restrict` 调整为 `onDelete: SetNull`

这样模板物理删除后：

- 历史实例记录仍保留
- `templateId` 自动或显式置空
- 前端优先使用实例快照回填模板展示信息

### No RangeTemplate soft delete

本方案不新增 `RangeTemplate.deletedAt`。

因为：

- 用户最新规则不是“隐藏模板，等实例销毁后再同步删”
- 而是“非 destroyed 时拦截；全 destroyed 时真删”

## Backend Behavior Design

### `DELETE /admin/scenarios/:id`

删除流程改为：

1. 读取模板及其关联实例
2. 如果存在任意 `status !== destroyed` 的实例：
   - 抛 `ConflictException`
   - message: `Range template cannot be deleted while non-destroyed instances still reference it`
3. 如果存在关联实例且全部为 `destroyed`：
   - 将模板关键字段批量写入这些实例的快照字段
   - 将这些实例的 `templateId` 置空
4. 删除模板及其版本记录
5. 返回 `204`

### Instance list/detail fallback

实例查询时增加模板回退逻辑：

- 若 `templateId` 仍存在：按现有逻辑用实时模板记录展示
- 若 `templateId` 为 `null`：使用实例快照字段展示模板名/slug/版本

### Delete failed instance endpoint

新增后端接口：

- `DELETE /admin/ranges/:id`

规则：

- 仅当实例状态为 `create_failed` 时允许删除
- 否则返回 `409`
- 删除实例时同步清理：
  - `ProvisionJob`
  - `ProvisionJobStepLog`
  - 实例自身记录

## Frontend Behavior Design

### Template delete dialog

前端不预先复杂计算实例状态，保持以后端真实校验为准，但文案要更明确：

- 删除模板时默认提示：
  - 如果模板仍存在运行中或未终态实例，必须先销毁这些实例后才能删除
  - 已销毁实例历史会保留

交互结果：

- 接口返回 `204`：从模板列表移除并提示成功
- 接口返回 `409`：展示冲突提示，不关闭页面

### Range instance actions

在“靶场实例”页 `操作` 列新增：

- 对 `create_failed` 实例显示 `删除`
- 对 `running` 继续显示 `关闭`
- 对 `destroy_failed` 继续显示 `销毁`

### History display

当模板已经删除时：

- `实例历史` 和详情弹窗中的模板名称来源切换到实例快照
- 不展示“未知靶场”，而是继续显示删除前模板名

## Files Affected

### Database

- `packages/database/prisma/schema.prisma`
- new migration under `packages/database/prisma/migrations/`

### API

- `apps/api/src/admin/admin.repository.ts`
- `apps/api/src/database/prisma-admin.repository.ts`
- `apps/api/src/admin/range-templates.service.ts`
- `apps/api/src/admin/range-instances.service.ts`
- `apps/api/src/admin/ranges.controller.ts`
- `apps/api/src/admin/dto/range-instance.dto.ts`
- `apps/api/src/admin/dto/range-template.dto.ts` if needed for response typing

### Web

- `apps/web/lib/admin-types.ts`
- `apps/web/lib/admin-api.ts`
- `apps/web/components/admin/templates-screen.tsx`
- `apps/web/components/admin/range-instances-screen.tsx`

### Tests

- `apps/api/test/admin-resources.e2e-spec.ts`
- `apps/api/test/support/create-memory-admin-repository.ts`
- `apps/web/components/admin/templates-screen.test.tsx`
- `apps/web/components/admin/range-instances-screen.test.tsx`

## Testing Strategy

### Backend

- deleting template with only destroyed linked instances returns `204`
- destroyed linked instances remain queryable after template deletion
- destroyed linked instances still expose template snapshot fields
- deleting template with any non-destroyed linked instance returns `409`
- deleting `create_failed` instance returns `204`
- deleting non-`create_failed` instance returns `409`

### Frontend

- template delete confirm dialog mentions the destroyed/non-destroyed rule
- `409` delete response surfaces explicit conflict copy
- deleted template disappears from template list
- `create_failed` row shows `删除`
- deleting failed instance removes row from the list
- deleted-template history rows still display original template name from snapshot

### Container validation

按项目约束，最终验证必须通过容器完成：

- rebuild affected images
- run API tests in `for-api-1`
- refresh `for-web-1`
- verify `3000` / `3001` runtime behavior

## Risks

### Template snapshot completeness

如果只保存模板名称，不保存 slug/version，历史页以后可能无法解释实例来源。  
因此至少保留：

- name
- slug
- version
- modulePath

### Destroy after template deletion

本方案只允许在“所有关联实例都已 destroyed”时删除模板，因此不存在“运行中实例失去蓝图后无法销毁”的风险。

### Existing historical records

旧数据中已存在的 `destroyed` 实例如果对应模板还未删除，不需要迁移填充快照；删除模板时再批量回填即可。

## Out of Scope

- 重新设计模板版本体系
- 为所有实例状态开放任意删除
- 自动清理 dry-run 历史脏数据的通用后台任务
- 改造实例详情为展示完整模板蓝图快照差异
