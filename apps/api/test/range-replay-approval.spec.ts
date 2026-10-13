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
  it('refuses a replay whose rules or network definitions no longer match the frozen launch', () => {
    const frozenRule = { key: 'entry-http', direction: 'ingress', policy: 'accept', protocol: 'tcp', portRange: '80/80', sourceCidr: '198.51.100.20/32', priority: 10 };
    const frozenSpec = { security_group_rules: [frozenRule], zone_acls: [{ key: 'office', rules: [] }] };
    expect(resolveReplayCreateApproval(instance(['dmz-entry'], frozenSpec),
      snapshot(['dmz-entry'], { security_group_rules: [{ ...frozenRule, sourceCidr: '0.0.0.0/0' }], zone_acls: frozenSpec.zone_acls }))).toBeNull();
    expect(resolveReplayCreateApproval(instance(['dmz-entry'], frozenSpec),
      snapshot(['dmz-entry'], { security_group_rules: [], zone_acls: frozenSpec.zone_acls }))).toBeNull();
    expect(resolveReplayCreateApproval(instance(['dmz-entry'], frozenSpec),
      snapshot(['dmz-entry'], { security_group_rules: frozenSpec.security_group_rules, zone_acls: [] }))).toBeNull();
  });
  it('refuses to approve any drift from the frozen launch definition', () => {
    expect(resolveReplayCreateApproval(instance(['dmz-entry'], { snatEntries: [{ key: 'snat-office' }] }), snapshot(['dmz-entry']))).toBeNull();
    expect(resolveReplayCreateApproval(instance(['dmz-entry'], { dnatEntries: [{ key: 'dnat-entry' }] }), snapshot(['dmz-entry']))).toBeNull();
    expect(resolveReplayCreateApproval({ ...(instance(['dmz-entry']) as Record<string, unknown>),
      runtimeTopologyGraph: { nodes: [{ ...ecs('dmz-entry'), cpu: 2 }] } } as never, { ...(snapshot(['dmz-entry']) as Record<string, unknown>),
      topologyGraph: { nodes: [{ ...ecs('dmz-entry'), cpu: 4 }] } } as never)).toBeNull();
  });
});
