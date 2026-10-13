import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ResourceAlertsScreen } from './resource-alerts-screen';
import { CloudReleaseSummary } from './shared/cloud-release-status';
import { AdminApiError } from '@/lib/admin-api';
import * as api from '@/lib/admin-api';

const state = vi.hoisted(() => ({ workspaceId: 'space-a' }));
vi.mock('./use-admin-session', () => ({ useAdminSession: () => ({ isReady: true, token: 'token', profile: { id: 'admin', role: 'admin', isPlatformManager: true } }) }));
vi.mock('./cloud-workspace-provider', () => ({ useCloudWorkspace: () => ({ workspace: { id: state.workspaceId } }) }));
vi.mock('./admin-page-cache', () => ({ useAdminRouteIsActive: () => true }));
vi.mock('@/lib/admin-api', async original => ({ ...await original<typeof import('@/lib/admin-api')>(), fetchResourceAlerts: vi.fn(), fetchResourcePatrol: vi.fn(), previewResourceReclaim: vi.fn(), reclaimResourceAlert: vi.fn(), setResourcePatrolManager: vi.fn() }));
const digest = 'a'.repeat(64);
const row = { id: 'alert', cloudWorkspaceId: 'space-a', provider: 'alibaba_cloud' as const, accountUid: '111', regionId: 'cn-hangzhou', type: 'ecs', resourceId: 'i-real', rangeInstanceId: null, rangeName: null, reason: '准确库存仍存在', status: 'pending' as const,
  firstSeenAt: '2026-10-13T00:00:00Z', lastSeenAt: '2026-10-13T01:00:00Z', evidenceSummary: { recordedInventory: true, sourceJobIds: ['job'], accountVerified: true }, remainingResources: [], errorSummary: null, jobId: null };
const preview = { alertId: 'alert', cloudWorkspaceId: 'space-a', provider: 'alibaba_cloud' as const, accountUid: '111', regionId: 'cn-hangzhou', rangeInstanceId: null, resources: [{ type: 'ecs', id: 'i-real' }], planDigest: digest, reclaimable: true, reason: null };
beforeEach(() => {
  state.workspaceId = 'space-a'; vi.resetAllMocks();
  vi.stubGlobal('crypto', { randomUUID: () => 'same-key' });
  vi.mocked(api.fetchResourceAlerts).mockResolvedValue([row]);
  vi.mocked(api.fetchResourcePatrol).mockResolvedValue({ managerUserId: 'admin', managerUsername: 'admin', cloudWorkspaceId: 'space-a', provider: 'alibaba_cloud', accountUid: '111', status: 'failed', lastScanAt: null, lastScanError: '分页不完整', regions: [], lastCompleted: null });
  vi.mocked(api.previewResourceReclaim).mockResolvedValue(preview);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe('resource alerts UI safety', () => {
  it('retains visible alerts when cloud inspection failed and blocks unproved reclaim', async () => {
    vi.mocked(api.previewResourceReclaim).mockResolvedValue({ ...preview, reclaimable: false, reason: '来源待核验' });
    render(<ResourceAlertsScreen />);
    await screen.findByText('i-real');
    expect(screen.getByText(/巡检失败/).textContent).toContain('现有告警已保留');
    fireEvent.click(screen.getByRole('button', { name: '查看清单' }));
    await screen.findByText('来源待核验');
    expect((screen.getByRole('button', { name: '确认回收' }) as HTMLButtonElement).disabled).toBe(true);
    expect(api.reclaimResourceAlert).not.toHaveBeenCalled();
  });
  it('confirms only the reviewed digest and reuses one key and workspace in both stages', async () => {
    vi.mocked(api.reclaimResourceAlert).mockRejectedValueOnce(new AdminApiError(409, 'confirm', { code: 'CONFIRMATION_REQUIRED', confirmationId: 'owned', idempotencyKey: 'same-key', summary: preview }))
      .mockResolvedValueOnce({ alertId: 'alert', status: 'reclaiming', jobId: 'job-a' });
    render(<ResourceAlertsScreen />);
    fireEvent.click(await screen.findByRole('button', { name: '查看清单' }));
    fireEvent.click(await screen.findByRole('button', { name: '确认回收' }));
    await waitFor(() => expect(api.reclaimResourceAlert).toHaveBeenCalledTimes(2));
    expect(api.reclaimResourceAlert).toHaveBeenLastCalledWith('/api', 'token', preview, 'space-a', { idempotencyKey: 'same-key', confirmationId: 'owned' });
  });
  it('never labels a partial fallback as fully verified', () => {
    const deadline = { provider: 'alibaba_cloud' as const, platformExpiresAt: '2026-10-13T01:00:00Z', creationPhaseStartedAt: '2026-10-13T00:00:00Z', cloudReleaseAt: '2026-10-13T01:05:00Z', sourceProvisionJobId: 'job', status: 'verified' as const, instanceId: 'i-a' };
    render(<CloudReleaseSummary hostIds={{ a: 'i-a', b: 'i-b' }} deadlines={{ a: deadline }} />);
    expect(screen.getByText('1/2 台已核验')).toBeTruthy();
  });
  it('discards a late confirmation after account switch and restores usable controls', async () => {
    let release!: (value: never) => void;
    vi.mocked(api.reclaimResourceAlert).mockImplementationOnce(() => new Promise((_, reject) => { release = reject; }));
    const rendered = render(<ResourceAlertsScreen />);
    fireEvent.click(await screen.findByRole('button', { name: '查看清单' }));
    fireEvent.click(await screen.findByRole('button', { name: '确认回收' }));
    await waitFor(() => expect(api.reclaimResourceAlert).toHaveBeenCalledTimes(1));
    state.workspaceId = 'space-b'; vi.mocked(api.fetchResourceAlerts).mockResolvedValue([]);
    rendered.rerender(<ResourceAlertsScreen />);
    release(new AdminApiError(409, 'confirm', { code: 'CONFIRMATION_REQUIRED', confirmationId: 'owned', idempotencyKey: 'same-key', summary: preview }) as never);
    await waitFor(() => expect((screen.getByRole('button', { name: '刷新' }) as HTMLButtonElement).disabled).toBe(false));
    expect(api.reclaimResourceAlert).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('i-real')).toBeNull();
  });
});
