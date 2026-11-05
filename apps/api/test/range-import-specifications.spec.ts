import { OpenTofuRangeProvisioner } from '../src/provisioning/open-tofu-range-provisioner';

describe('imported range CPU and memory specifications', () => {
  function request(cpu: number, memory: number, env = {}) {
    const provisioner = new OpenTofuRangeProvisioner({ env });
    const plan = { hostDefinitions: [{ key: 'source' }], hostNetworkInterfaces: [], runtimeSelections: { instanceTypePolicies: {} } };
    const hostProvisioningHints = new Map([['source', { requestedCpu: cpu, requestedMemoryGiB: memory }]]);
    return (provisioner as any).buildHostInstanceTypeRequests({ plan, hostProvisioningHints })[0];
  }

  it.each([[1, 2], [4, 4], [2, 6]])('keeps %i vCPU / %i GiB and requests exact discovery', (cpu, memory) => {
    expect(request(cpu, memory)).toMatchObject({ cpu, memoryGiB: memory, exactResources: true, preferredInstanceTypes: [] });
  });

  it('keeps existing presets and explicit instance type overrides', () => {
    expect(request(2, 4).exactResources).toBeUndefined();
    expect(request(2, 4).preferredInstanceTypes).toContain('ecs.e-c1m2.large');
    expect(request(1, 2, { OPENTOFU_INSTANCE_TYPE: 'ecs.fixed' })).toMatchObject({
      strictPreferredInstanceTypes: true, preferredInstanceTypes: ['ecs.fixed'],
    });
  });
});
