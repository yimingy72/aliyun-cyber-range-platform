import { resolveReplayCreateApproval } from '../src/provisioning/provisioning-worker.service';

const ecs = (id: string) => ({ id, kind: 'ecs', label: id });
const instance = (ids: string[], compiledProvisionSpec: Record<string, unknown> = {}) => ({
  id: 'range-1', cloudProvider: 'alibaba_cloud', cloudWorkspaceId: 'space-1', status: 'create_failed',
  runtimeTopologyGraph: { schemaVersion: '2.0.0', nodes: ids.map(ecs), edges: [] },
  runtimeScenarioTemplateSpec: {}, runtimeCompiledProvisionSpec: compiledProvisionSpec, runtimeCredentials: null,
  resourceSummary: { mode: 'opentofu', hostIds: Object.fromEntries(ids.map(id => [id, `i-${id.replaceAll('-', '')}`])) },
  expiresAt: new Date(Date.now() + 3600_000),
}) as never;
const snapshot = (ids: string[], compiledProvisionSpec: Record<string, unknown> = {}) => ({
  draftRevision: 0, templateModulePath: 'infra/opentofu/modules/alicloud-enterprise-range',
  topologyGraph: { schemaVersion: '2.0.0', nodes: ids.map(ecs), edges: [] },
  topologySpec: {}, scenarioTemplateSpec: {}, compiledProvisionSpec, compiledSpec: {},
}) as never;

describe('replay create approval', () => {
  it('reuses the frozen launch as the approval for an unchanged replay', () => {
    const approval = resolveReplayCreateApproval(instance(['dmz-entry', 'office-backend']), snapshot(['dmz-entry', 'office-backend']));
    expect(approval).toMatchObject({ version: 1, addedHostKeys: [], deletedHostKeys: [], allowDnatRemoval: false, allowSnatRemoval: false });
  });
  it('refuses to approve a replay that would remove or add a deployed host', () => {
    expect(resolveReplayCreateApproval(instance(['dmz-entry', 'office-backend']), snapshot(['dmz-entry']))).toBeNull();
    expect(resolveReplayCreateApproval(instance(['dmz-entry']), snapshot(['dmz-entry', 'office-backend']))).toBeNull();
  });
  it('refuses to approve a replay that would drop release rules or the frozen host identity', () => {
    expect(resolveReplayCreateApproval(instance(['dmz-entry'], { snatEntries: [{ key: 'snat-office' }] }), snapshot(['dmz-entry']))).toBeNull();
    expect(resolveReplayCreateApproval(instance(['dmz-entry'], { dnatEntries: [{ key: 'dnat-entry' }] }), snapshot(['dmz-entry']))).toBeNull();
    expect(() => resolveReplayCreateApproval({ ...(instance(['dmz-entry']) as Record<string, unknown>),
      runtimeTopologyGraph: { nodes: [{ ...ecs('dmz-entry'), cpu: 2 }] } } as never, { ...(snapshot(['dmz-entry']) as Record<string, unknown>),
      topologyGraph: { nodes: [{ ...ecs('dmz-entry'), cpu: 4 }] } } as never)).toThrow('不能修改');
  });
});
