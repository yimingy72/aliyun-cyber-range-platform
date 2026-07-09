# Single Instance Screen Tab Split Design

## Goal

Restructure the admin `实例管理` page so active single instances and active instance batches no longer share one mixed list. Keep one unified history tab, but render single-instance history and batch history as separate sections.

## Approved UX

- Top-right tabs become:
  - `实例列表`
  - `实例批次`
  - `实例历史`
- `实例列表`
  - Shows only standalone single-instance rows.
  - Keeps the current instance-level columns and actions.
- `实例批次`
  - Shows only batch summary rows.
  - Expanding a batch reveals child instance rows.
  - Parent batch rows keep batch-only columns.
  - Child rows keep instance-only columns.
- `实例历史`
  - Remains one tab.
  - Renders two sections in order:
    - `单实例历史`
    - `批次历史`
  - Batch history keeps expandable child rows.

## Alignment Rules

- Headers and their data cells should use left alignment.
- Do not try to visually align parent batch columns with child instance columns across two different table levels.
- Each section should align internally:
  - batch headers with batch data
  - child-instance headers with child-instance data
  - single-instance headers with single-instance data

## Column Definitions

### 实例列表

- 实例名
- 镜像
- 规格
- 公网 IP
- 状态
- 创建时间
- 到期时间
- 创建人
- 账号/密码
- 操作

### 实例批次

- 批次名
- 镜像
- 数量
- 状态汇总
- 创建时间
- 到期时间
- 创建人
- 批量操作

Expanded child rows:

- 实例名
- 规格
- 公网 IP
- 账号/密码
- 状态
- 操作

### 实例历史

Single-instance history columns:

- 实例名
- 创建人
- 镜像
- 规格
- 公网 IP
- 开启时间
- 回收时间
- 运行时长

Batch history columns:

- 批次名
- 镜像
- 数量
- 结果汇总
- 创建时间
- 结束时间
- 创建人

Expanded batch child history rows:

- 实例名
- 规格
- 公网 IP
- 账号/密码
- 状态

## Data / Filtering Notes

- Reuse the current `fetchSingleInstances` payload.
- `实例列表` uses `standaloneInstances`.
- `实例批次` uses `batches`.
- `实例历史`
  - single-instance history uses destroyed `standaloneInstances`
  - batch history uses destroyed `batches`
- Search filters only the current active tab/section.

## Scope

- Frontend only.
- No API changes.
- No backend behavior changes.
