import { describe, expect, it } from 'vitest';
import { topologyGraphSchema } from '../src/tools/template-schemas';
const dns = { servers: ['10.0.0.10'], nicIds: ['nic-primary'], domain: 'ad.test' };
function graph(override: unknown = dns) {
  return { schemaVersion: '2.0.0', nodes: [
    { id: 'router', kind: 'router', label: 'Router' },
    { id: 'host', kind: 'ecs', label: 'Windows', zoneKey: 'dmz', role: 'member', privateIp: '10.0.0.20', image: 'Windows', imageId: 'test-image', platformImageAssetId: 'asset', imageStrategy: { mode: 'fixed', imageId: 'test-image' }, instanceTypeStrategy: { mode: 'auto' }, nics: [{ id: 'nic-primary', switchId: 'switch', privateIp: '10.0.0.20' }], dns: override },
  ], edges: [] };
}
describe('MCP host DNS input schema', () => {
  it('preserves the complete per-host DNS object', () => {
    expect((topologyGraphSchema.parse(graph()).nodes[1] as any).dns).toEqual(dns);
  });
  it.each([
    { ...dns, servers: ['0.0.0.0'] }, { ...dns, servers: ['224.0.0.1'] }, { ...dns, servers: ['255.255.255.255'] },
    { ...dns, servers: [] }, { ...dns, servers: ['999.0.0.1'] }, { ...dns, servers: ['10.0.0.10', '10.0.0.10'] },
    { ...dns, servers: ['10.0.0.10\nWrite-Host hacked'] }, { ...dns, nicIds: [] }, { ...dns, nicIds: ['foreign'] },
    { ...dns, nicIds: ['nic-primary', 'nic-primary'] }, { ...dns, domain: 'ad.test;shutdown' }, { ...dns, typo: true }, null,
  ])('rejects malformed DNS rather than stripping it', (value) => {
    expect(topologyGraphSchema.safeParse(graph(value)).success).toBe(false);
  });
  it('accepts legacy input with no DNS configuration', () => {
    const value = graph(); delete (value.nodes[1] as any).dns;
    expect((topologyGraphSchema.parse(value).nodes[1] as any).dns).toBeUndefined();
  });
});
