# 管理后台靶场生命周期闭环 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让管理员可以在后台完成“创建比赛/队伍/模板 -> 创建靶场实例 -> 发起创建/销毁任务 -> 在页面内看到状态与步骤日志回写”的最小闭环。

**Architecture:** 继续沿用现有 `Admin REST API + Next.js 后台页面` 架构，不新增后端编排模型，只补 Web 端的实例创建入口和任务状态轮询。实例创建走现有 `POST /admin/range-instances`，任务回写通过轮询 `GET /admin/range-instances/:id` 与 `GET /admin/provision-jobs/:id/steps` 完成。

**Tech Stack:** Next.js 15 App Router、React 19、Vitest + Testing Library、现有 Admin REST API

---

## 代码结构预定稿

- Modify: `apps/web/lib/admin-types.ts`
  - 增加 `RangeInstanceCreateInput` 和更完整的 `RangeInstance / ProvisionJob / ProvisionJobStep` 前端类型
- Modify: `apps/web/lib/admin-api.ts`
  - 增加 `createRangeInstance()` API 封装
- Modify: `apps/web/components/admin/range-instances-screen.tsx`
  - 增加实例创建表单、任务触发后的状态轮询、详情面板自动回写
- Modify: `apps/web/components/admin/range-instances-screen.test.tsx`
  - 覆盖“创建实例”和“触发任务后自动刷新详情/步骤日志”

### Task 1: 补齐实例创建入口

**Files:**
- Modify: `apps/web/lib/admin-types.ts`
- Modify: `apps/web/lib/admin-api.ts`
- Modify: `apps/web/components/admin/range-instances-screen.tsx`
- Test: `apps/web/components/admin/range-instances-screen.test.tsx`

- [ ] **Step 1: 先写失败测试**

```tsx
it('creates a draft range instance from the admin page', async () => {
  fetchAdminBootstrapMock.mockResolvedValue({
    competitions: [{ id: 'competition-1', name: '总决赛' }],
    teams: [{ id: 'team-1', name: '蓝队', competitionId: 'competition-1' }],
    rangeTemplates: [{ id: 'template-1', name: '企业攻防靶场', slug: 'enterprise-range', version: 'v1' }],
    rangeInstances: [],
    provisionJobs: [],
  });
  createRangeInstanceMock.mockResolvedValue({
    id: 'range-1',
    competitionId: 'competition-1',
    teamId: 'team-1',
    templateId: 'template-1',
    status: 'draft',
    accessEntry: null,
    resourceSummary: null,
    errorSummary: null,
    expiresAt: null,
    lastJobId: null,
  });

  render(<RangeInstancesScreen apiBaseUrl="http://localhost:3001" />);

  await screen.findByRole('button', { name: '创建实例' });
  fireEvent.click(screen.getByRole('button', { name: '创建实例' }));

  await waitFor(() => {
    expect(createRangeInstanceMock).toHaveBeenCalledWith('http://localhost:3001', 'dev-admin-token', {
      competitionId: 'competition-1',
      teamId: 'team-1',
      templateId: 'template-1',
    });
  });
});
```

- [ ] **Step 2: 运行测试，确认先失败**

Run: `pnpm --filter @aliyun-cyber-range/web test -- components/admin/range-instances-screen.test.tsx`

Expected: FAIL，原因是前端还没有 `createRangeInstance()`，实例页也没有创建入口。

- [ ] **Step 3: 写最小实现**

```ts
export type RangeInstanceCreateInput = {
  competitionId: string;
  teamId: string;
  templateId: string;
  expiresAt?: string;
};
```

```ts
export async function createRangeInstance(apiBaseUrl: string, token: string, payload: RangeInstanceCreateInput) {
  const response = await fetch(`${apiBaseUrl}/admin/range-instances`, {
    method: 'POST',
    headers: createAdminHeaders(token),
    body: JSON.stringify(payload),
  });

  return readJson<RangeInstanceDetail>(response);
}
```

```tsx
<form className="admin-form" onSubmit={(event) => void handleCreateInstance(event)}>
  <label>
    <span>所属比赛</span>
    <select aria-label="所属比赛" />
  </label>
  <label>
    <span>所属队伍</span>
    <select aria-label="所属队伍" />
  </label>
  <label>
    <span>靶场模板</span>
    <select aria-label="靶场模板" />
  </label>
  <label>
    <span>过期时间</span>
    <input aria-label="过期时间" type="datetime-local" />
  </label>
  <button type="submit">创建实例</button>
</form>
```

- [ ] **Step 4: 重新运行测试，确认转绿**

Run: `pnpm --filter @aliyun-cyber-range/web test -- components/admin/range-instances-screen.test.tsx`

Expected: PASS，且创建后实例立即出现在列表中。

### Task 2: 让任务触发后的状态与步骤日志自动回写

**Files:**
- Modify: `apps/web/components/admin/range-instances-screen.tsx`
- Test: `apps/web/components/admin/range-instances-screen.test.tsx`

- [ ] **Step 1: 先写失败测试**

```tsx
it('refreshes instance detail and latest steps after create job starts', async () => {
  vi.useFakeTimers();

  fetchAdminBootstrapMock.mockResolvedValue({
    competitions: [{ id: 'competition-1', name: '总决赛' }],
    teams: [{ id: 'team-1', name: '蓝队', competitionId: 'competition-1' }],
    rangeTemplates: [{ id: 'template-1', name: '企业攻防靶场', slug: 'enterprise-range', version: 'v1' }],
    rangeInstances: [{ id: 'range-1', teamId: 'team-1', competitionId: 'competition-1', templateId: 'template-1', status: 'draft', lastJobId: null }],
    provisionJobs: [],
  });
  fetchRangeInstanceDetailMock
    .mockResolvedValueOnce({ id: 'range-1', competitionId: 'competition-1', teamId: 'team-1', templateId: 'template-1', status: 'draft', lastJobId: null, accessEntry: null, resourceSummary: null })
    .mockResolvedValueOnce({ id: 'range-1', competitionId: 'competition-1', teamId: 'team-1', templateId: 'template-1', status: 'running', lastJobId: 'job-1', accessEntry: { hostRole: 'dmz', url: 'https://range.local/range-1' }, resourceSummary: { mode: 'dry-run' } });
  fetchProvisionJobDetailMock.mockResolvedValue({
    job: { id: 'job-1', rangeInstanceId: 'range-1', jobType: 'create', status: 'succeeded', triggeredBy: 'admin' },
    steps: [{ id: 'step-1', jobId: 'job-1', stepName: 'collect_outputs', status: 'succeeded', message: '已写入入口信息' }],
  });
  triggerRangeActionMock.mockResolvedValue({ id: 'job-1', rangeInstanceId: 'range-1', jobType: 'create', status: 'pending', triggeredBy: 'admin' });

  render(<RangeInstancesScreen apiBaseUrl="http://localhost:3001" />);

  await screen.findByText('靶场实例');
  fireEvent.click(screen.getByRole('button', { name: '查看实例 range-1' }));
  await screen.findByRole('button', { name: '发起创建' });
  fireEvent.click(screen.getByRole('button', { name: '发起创建' }));

  await vi.advanceTimersByTimeAsync(2500);

  await screen.findByText(/状态：运行中/);
  await screen.findByText(/collect_outputs\s*\/\s*成功\s*\/\s*已写入入口信息/);
});
```

- [ ] **Step 2: 运行测试，确认先失败**

Run: `pnpm --filter @aliyun-cyber-range/web test -- components/admin/range-instances-screen.test.tsx`

Expected: FAIL，原因是当前触发任务后只把最近任务改成 `pending`，不会继续刷新详情和步骤日志。

- [ ] **Step 3: 写最小轮询实现**

```tsx
useEffect(() => {
  if (!session.token || !selectedDetail?.id || !selectedDetail.lastJobId) {
    return;
  }

  if (!['pending_create', 'creating', 'pending_destroy', 'destroying'].includes(selectedDetail.status)) {
    return;
  }

  const timer = window.setTimeout(() => {
    void refreshSelectedInstance(selectedDetail.id, { keepPolling: true });
  }, 2500);

  return () => window.clearTimeout(timer);
}, [apiBaseUrl, selectedDetail?.id, selectedDetail?.lastJobId, selectedDetail?.status, session.token]);
```

```tsx
setSelectedDetail((current) =>
  current
    ? {
        ...current,
        lastJobId: job.id,
        status: action === 'create' ? 'pending_create' : 'pending_destroy',
      }
    : current,
);
```

- [ ] **Step 4: 重新运行测试，确认转绿**

Run: `pnpm --filter @aliyun-cyber-range/web test -- components/admin/range-instances-screen.test.tsx`

Expected: PASS，且实例详情会从 `pending_*` 自动刷新到终态，并带出最新步骤日志。

- [ ] **Step 5: 跑 Web 全量测试和构建**

Run:

```bash
pnpm --filter @aliyun-cyber-range/web test
pnpm --filter @aliyun-cyber-range/web build
```

Expected: PASS。
