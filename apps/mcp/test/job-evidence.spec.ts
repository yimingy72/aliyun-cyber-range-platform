import { describe, expect, it, vi } from 'vitest';
import { PlatformApiClient } from '@aliyun-cyber-range/platform-api-client';
import { createToolRegistry } from '../src/server';

describe('job evidence MCP path', () => {
  it('forwards opt-in evidence through the SDK and preserves its safe projection', async () => {
    const fetch = vi.fn(async (_url: string) => new Response(JSON.stringify({ id: 'job/source', status: 'succeeded', evidence: {
      coverage: 'platform_recorded_job_evidence', inventories: [], invalidInventoryCount: 0,
      steps: [{ stepName: 'verify_destroy', status: 'succeeded', description: 'Platform cloud absence verification' }], relatedJobs: [], billingResources: [],
    } })));
    const registry = createToolRegistry(new PlatformApiClient({ baseUrl: 'https://platform.example', token: 'fixture-token', fetch: fetch as typeof globalThis.fetch }));
    await expect(registry.callTool('provision_job_get', ['jobs:read'], { provisionJobId: 'job/source', includeEvidence: true }))
      .resolves.toMatchObject({ structuredContent: { result: { evidence: { coverage: 'platform_recorded_job_evidence', steps: [{ stepName: 'verify_destroy' }] } } } });
    expect(fetch.mock.calls[0]?.[0]).toBe('https://platform.example/admin/provision-jobs/job%2Fsource?includeEvidence=true');
  });
  it('requires jobs:read and a boolean flag', async () => {
    const registry = createToolRegistry({ getProvisionJob: vi.fn() } as any);
    await expect(registry.callTool('provision_job_get', [], { provisionJobId: 'job-1', includeEvidence: true })).rejects.toThrow('Forbidden');
    await expect(registry.callTool('provision_job_get', ['jobs:read'], { provisionJobId: 'job-1', includeEvidence: 'true' })).rejects.toThrow('Invalid input');
  });
  it('forwards bounded cloud-event selection and rejects arbitrary IDs or selection without an explicit flag', async () => {
    const getProvisionJob = vi.fn(async () => ({ id: 'job-1', evidence: { cloudEvents: [] } }));
    const registry = createToolRegistry({ getProvisionJob } as any);
    await registry.callTool('provision_job_get', ['jobs:read'], { provisionJobId: 'job-1', includeCloudEvents: true, cloudResourceIds: ['eip-owned'] });
    expect(getProvisionJob).toHaveBeenCalledWith('job-1', { includeCloudEvents: true, cloudResourceIds: ['eip-owned'] });
    for (const args of [{ cloudResourceIds: ['eip-owned'] }, { includeCloudEvents: true, cloudResourceIds: ['../../secret'] },
      { includeCloudEvents: true, cloudResourceIds: Array.from({ length: 21 }, (_, i) => 'eip-' + i) }]) {
      await expect(registry.callTool('provision_job_get', ['jobs:read'], { provisionJobId: 'job-1', ...args })).rejects.toThrow('Invalid input');
    }
    expect(getProvisionJob).toHaveBeenCalledTimes(1);
  });
});
