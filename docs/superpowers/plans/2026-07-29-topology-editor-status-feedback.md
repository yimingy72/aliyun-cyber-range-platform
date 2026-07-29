# 拓扑编辑器状态反馈位置 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将创建拓扑页的操作反馈移至标题下方的小字区域，并取消自动布局成功提示。

**Architecture:** `TemplateEditorScreen` 继续拥有 `statusMessage` 状态，不改动检测、保存或发布的数据流。仅调整其渲染位置与工具栏局部样式；自动布局成功提交快照后清空状态而非写入成功文案。

**Tech Stack:** React 19、Next.js、Vitest、Testing Library、CSS。

---

### Task 1: 锁定状态反馈的回归行为

**Files:**
- Modify: `apps/web/components/admin/template-editor/template-editor-screen.test.tsx`

- [ ] **Step 1: 为检测失败的标题区状态提示写失败测试**

在现有“blocks incomplete topologies during 检测与保存”场景中，将状态相关断言扩展为：

```tsx
const status = screen.getByRole('status');

expect(status).toHaveTextContent(/拓扑检测未通过：至少需要一个 ECS 主机/);
expect(status.closest('.template-editor-toolbar-copy')).toBeTruthy();
expect(status.getAttribute('title')).toMatch(/至少需要一个 ECS 主机/);
expect(document.querySelector('.template-editor-screen > p[role="status"]')).toBeNull();
```

- [ ] **Step 2: 在 Docker 中运行该测试并确认失败**

Run:

```bash
docker compose --env-file .env run --rm --no-deps web \
  pnpm --filter @aliyun-cyber-range/web exec vitest run \
  components/admin/template-editor/template-editor-screen.test.tsx
```

Expected: 失败，原因是当前 `role="status"` 段落位于 `.template-editor-screen` 的画布网格之后，而不是 `.template-editor-toolbar-copy` 中。

- [ ] **Step 3: 为自动布局成功无提示写失败测试**

新增测试，使用已有拓扑编辑器画布 mock 的 `flow layout all` 按钮触发布局：

```tsx
it('does not announce successful automatic layout', () => {
  render(<TemplateEditorScreen template={emptyTopologyTemplate} />);

  fireEvent.click(screen.getByRole('button', { name: '交换机 switch' }));
  expect(screen.getByRole('status')).toHaveTextContent('已添加交换机 1');

  fireEvent.click(screen.getByRole('button', { name: 'flow layout all' }));

  expect(screen.queryByText('已完成全部自动布局。')).toBeNull();
  expect(screen.queryByRole('status')).toBeNull();
});
```

`emptyTopologyTemplate` 使用当前文件中“blocks incomplete topologies during 检测与保存”测试的同一空拓扑模板对象；点击 mock 画布中的“交换机 switch”后即可获得自动布局所需的一个节点。

- [ ] **Step 4: 在 Docker 中运行测试并确认失败**

Run the command from Step 2.

Expected: 失败，原因是 `handleLayoutAll` 仍将“已完成全部自动布局。”写入 `statusMessage`。

### Task 2: 移动标题区状态反馈并移除自动布局成功消息

**Files:**
- Modify: `apps/web/components/admin/template-editor/template-editor-screen.tsx:1843-1853`
- Modify: `apps/web/components/admin/template-editor/template-editor-screen.tsx:1981-2049`
- Modify: `apps/web/app/globals.css:1347-1377`

- [ ] **Step 1: 将标题区标记拆分为身份行和状态行**

将工具栏左侧标记改为以下结构，移除画布网格后的独立状态段落：

```tsx
<div className="template-editor-toolbar-copy">
  <div className="template-editor-toolbar-identity">
    <h1>{template.name ?? template.slug}</h1>
    <Badge
      className="template-editor-toolbar-status"
      variant={template.status === 'published' ? 'default' : 'outline'}
    >
      {template.status === 'published' ? '已发布' : '私有'}
    </Badge>
  </div>
  {statusMessage ? (
    <p
      aria-live="polite"
      className="template-editor-toolbar-secondary template-editor-feedback"
      role="status"
      title={statusMessage}
    >
      {statusMessage}
    </p>
  ) : null}
</div>
```

- [ ] **Step 2: 添加仅限标题区的紧凑样式**

保持操作按钮区域不变，改用以下局部规则：

```css
.template-editor-toolbar-copy {
  display: grid;
  gap: 4px;
  flex: 1 1 auto;
  min-width: 0;
}

.template-editor-toolbar-identity {
  display: flex;
  align-items: baseline;
  gap: 12px;
  min-width: 0;
}

.template-editor-feedback {
  margin: 0;
  color: var(--muted-foreground);
  font-size: 12px;
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

- [ ] **Step 3: 取消自动布局成功文本**

保留布局快照提交，传入空消息以清除旧反馈：

```tsx
commitSnapshot({ nodes: layoutTopology(nodes, edges), edges, viewport }, '');
```

保留 `catch` 中的“自动布局失败，请保留当前节点位置。”提示。

- [ ] **Step 4: 在 Docker 中运行编辑器测试并确认通过**

Run the command from Task 1 Step 2.

Expected: `template-editor-screen.test.tsx` 全部通过；状态位于标题区，自动布局成功不再产生文本。

### Task 3: 验证构建与运行容器

**Files:**
- Verify: `apps/web/components/admin/template-editor/template-editor-screen.tsx`
- Verify: `apps/web/components/admin/template-editor/template-editor-screen.test.tsx`
- Verify: `apps/web/app/globals.css`

- [ ] **Step 1: 运行 Web 全量测试**

```bash
docker compose --env-file .env run --rm --no-deps web \
  pnpm --filter @aliyun-cyber-range/web test
```

Expected: 全部 Web 测试通过。

- [ ] **Step 2: 构建并替换 Web 容器**

```bash
COMPOSE_BAKE=false docker compose --env-file .env build web
docker compose --env-file .env up -d --no-deps --force-recreate web
curl -fsSI --max-time 10 http://localhost:13000/admin/scenarios
```

Expected: 构建通过，`topology-flow-canvas-web-1` 运行，路由返回 `HTTP/1.1 200 OK`。

- [ ] **Step 3: 提交本次状态反馈变更**

```bash
git add \
  apps/web/app/globals.css \
  apps/web/components/admin/template-editor/template-editor-screen.tsx \
  apps/web/components/admin/template-editor/template-editor-screen.test.tsx \
  docs/superpowers/plans/2026-07-29-topology-editor-status-feedback.md
git commit -m "fix(web): relocate topology editor feedback"
```

Expected: 仅提交本计划列出的状态反馈文件；不包含已存在的其他未提交工作。
