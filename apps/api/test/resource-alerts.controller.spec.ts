import { ResourceAlertsController } from '../src/admin/resource-alerts.controller';
import { OperationControlService } from '../src/operations/operation-control.service';
import { createMemoryAdminRepository } from './support/create-memory-admin-repository';
import { runInCloudWorkspace } from '../src/auth/cloud-workspace-scope';
import { assertDelegatedApiScopes } from '../src/auth/delegated-api-scopes';
import type { AuthenticatedPlatformRequest } from '../src/auth/request-auth-context';

const digest = 'a'.repeat(64);
const scope = { cloudWorkspaceId: 'space-a', provider: 'alibaba_cloud' as const, accountUid: '111' };
const user = { id: 'admin', username: 'admin', role: 'admin' as const, isPlatformManager: true };
function request(source: 'web' | 'mcp', confirmationId?: string): AuthenticatedPlatformRequest {
  return { headers: { 'x-idempotency-key': 'one-cleanup', ...(confirmationId ? { 'x-confirmation-id': confirmationId } : {}) },
    adminUser: user, authContext: { source, user, oauthClientId: source === 'mcp' ? 'mcp-gateway' : 'platform-web' } };
}
describe('resource alert confirmation boundary', () => {
  it.each(['web', 'mcp'] as const)('requires confirmation and keeps asynchronous job audit for %s', async source => {
    const repository = createMemoryAdminRepository();
    const audit = jest.spyOn(repository, 'appendOperationAuditEvent');
    const reclaim = jest.fn(async () => ({ alertId: 'alert-a', status: 'reclaiming', jobId: 'job-cleanup' }));
    const preview = jest.fn(async () => ({ alertId: 'alert-a', resources: [{ type: 'ecs', id: 'i-real' }], planDigest: digest, reclaimable: true, reason: null }));
    const controller = new ResourceAlertsController({ preview, reclaim } as never, new OperationControlService(repository));
    await runInCloudWorkspace(scope, async () => {
      let challenge: { confirmationId: string };
      try { await controller.reclaim(request(source), 'alert-a', { planDigest: digest }); throw new Error('expected confirmation'); }
      catch (error) { challenge = (error as { getResponse(): any }).getResponse(); }
      expect(reclaim).not.toHaveBeenCalled();
      const response = await controller.reclaim(request(source, challenge!.confirmationId), 'alert-a', { planDigest: digest });
      expect(response).toMatchObject({ alertId: 'alert-a', jobId: 'job-cleanup' });
      expect(await repository.getIdempotentOperation('admin', 'resource_alert_reclaim', 'one-cleanup')).toMatchObject({ result: { jobId: 'job-cleanup' } });
      expect(audit).toHaveBeenCalledWith(expect.objectContaining({ phase: 'dispatched', jobId: 'job-cleanup' }));
      await controller.reclaim(request(source, challenge!.confirmationId), 'alert-a', { planDigest: digest });
      expect(reclaim).toHaveBeenCalledTimes(1);
    });
  });
  it('rejects changed or unproved previews before issuing a confirmation', async () => {
    const operations = new OperationControlService(createMemoryAdminRepository());
    const preview = jest.fn(async () => ({ reclaimable: false, reason: 'source unverified', planDigest: digest }));
    const reclaim = jest.fn();
    const controller = new ResourceAlertsController({ preview, reclaim } as never, operations);
    await runInCloudWorkspace(scope, () => expect(controller.reclaim(request('web'), 'a', { planDigest: digest })).rejects.toThrow('source unverified'));
    expect(reclaim).not.toHaveBeenCalled();
  });
  it('requires the complete destructive scope set on delegated API access', () => {
    const path = '/admin/resource-alerts/alert-a/reclaim';
    for (const scopes of [['settings:read'], ['settings:write'], ['settings:write', 'ranges:destroy'], ['settings:write', 'instances:destroy']])
      expect(() => assertDelegatedApiScopes('POST', path, new Set(scopes))).toThrow();
    expect(() => assertDelegatedApiScopes('POST', path, new Set(['settings:write', 'ranges:destroy', 'instances:destroy']))).not.toThrow();
  });
});
