import { selectZoneAndHostInstanceTypes } from '../src/provisioning/aliyun-zone-instance-scheduler';

describe('selectZoneAndHostInstanceTypes', () => {
  afterEach(() => jest.restoreAllMocks());

  it('upgrades a multi-NIC host to the least-cost saleable type with sufficient ENI capacity', async () => {
    const originalFetch = global.fetch;
    const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes('Action=DescribeInstanceTypes')) {
        return {
          ok: true,
          json: async () => ({
            TotalCount: 3,
            InstanceTypes: {
              InstanceType: [
                {
                  InstanceTypeId: 'ecs.e-c1m1.large',
                  CpuArchitecture: 'x86_64',
                  CpuCoreCount: 2,
                  MemorySize: 2,
                  EniQuantity: 2,
                },
                {
                  InstanceTypeId: 'ecs.c6.xlarge',
                  CpuArchitecture: 'x86_64',
                  CpuCoreCount: 4,
                  MemorySize: 8,
                  EniQuantity: 3,
                },
                {
                  InstanceTypeId: 'ecs.hfc6.xlarge',
                  CpuArchitecture: 'x86_64',
                  CpuCoreCount: 4,
                  MemorySize: 8,
                  EniQuantity: 3,
                },
              ],
            },
          }),
        } as Response;
      }

      if (url.includes('Action=DescribeAvailableResource')) {
        return {
          ok: true,
          json: async () => ({
            AvailableZones: {
              AvailableZone: {
                AvailableResources: {
                  AvailableResource: {
                    Type: 'InstanceType',
                    SupportedResources: {
                      SupportedResource: [
                        { Value: 'ecs.e-c1m1.large', Status: 'Available' },
                        { Value: 'ecs.c6.xlarge', Status: 'Available' },
                        { Value: 'ecs.hfc6.xlarge', Status: 'Available' },
                      ],
                    },
                  },
                },
              },
            },
          }),
        } as Response;
      }

      if (url.includes('Action=DescribePrice') && url.includes('InstanceType=ecs.c6.xlarge')) {
        return {
          ok: true,
          json: async () => ({ PriceInfo: { Price: { TradePrice: 0.7898 } } }),
        } as Response;
      }

      if (url.includes('Action=DescribePrice') && url.includes('InstanceType=ecs.hfc6.xlarge')) {
        return {
          ok: true,
          json: async () => ({ PriceInfo: { Price: { TradePrice: 0.90563333 } } }),
        } as Response;
      }

      throw new Error(`Unexpected request: ${url}`);
    });
    global.fetch = fetchMock as typeof global.fetch;

    try {
      const result = await selectZoneAndHostInstanceTypes({
        regionId: 'cn-hangzhou',
        defaultZoneId: 'cn-hangzhou-h',
        systemDiskCategory: 'cloud_essd',
        account: { accessKeyId: 'test-ak', accessKeySecret: 'test-sk' },
        hostRequests: [
          {
            hostKey: 'pivot-host',
            cpu: 2,
            memoryGiB: 2,
            preferredInstanceTypes: ['ecs.e-c1m1.large'],
            networkInterfaceCount: 3,
          } as never,
        ],
      });

      expect(result.selectedZoneId).toBe('cn-hangzhou-h');
      expect(result.hostInstanceTypes).toEqual({ 'pivot-host': 'ecs.c6.xlarge' });
      expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('Action=DescribePrice'))).toHaveLength(2);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it.each([[1, 2], [4, 4]])('matches %i vCPU / %i GiB without replacing the source specification', async (cpu, memoryGiB) => {
    const candidates = [
      { InstanceTypeId: 'ecs.exact-a', CpuArchitecture: 'x86_64', CpuCoreCount: cpu, MemorySize: memoryGiB, EniQuantity: 2 },
      { InstanceTypeId: 'ecs.exact-b', CpuArchitecture: 'x86_64', CpuCoreCount: cpu, MemorySize: memoryGiB, EniQuantity: 2 },
      { InstanceTypeId: 'ecs.larger', CpuArchitecture: 'x86_64', CpuCoreCount: cpu * 2, MemorySize: memoryGiB * 2, EniQuantity: 3 },
      { InstanceTypeId: 'ecs.arm', CpuArchitecture: 'arm64', CpuCoreCount: cpu, MemorySize: memoryGiB, EniQuantity: 3 },
      { InstanceTypeId: 'ecs.nic-short', CpuArchitecture: 'x86_64', CpuCoreCount: cpu, MemorySize: memoryGiB, EniQuantity: 1 },
      { InstanceTypeId: 'ecs.unavailable', CpuArchitecture: 'x86_64', CpuCoreCount: cpu, MemorySize: memoryGiB, EniQuantity: 2 },
    ];
    const quotes: string[] = [];
    jest.spyOn(global, 'fetch').mockImplementation(async value => {
      const params = new URL(String(value)).searchParams;
      const action = params.get('Action');
      if (action === 'DescribeInstanceTypes') return { ok: true, json: async () => ({ TotalCount: candidates.length, InstanceTypes: { InstanceType: candidates } }) } as Response;
      if (action === 'DescribeAvailableResource') return { ok: true, json: async () => ({ AvailableZones: { AvailableZone: { AvailableResources: { AvailableResource: {
        Type: 'InstanceType', SupportedResources: { SupportedResource: candidates.filter(t => t.InstanceTypeId !== 'ecs.unavailable').map(t => ({ Value: t.InstanceTypeId, Status: 'Available' })) },
      } } } } }) } as Response;
      if (action === 'DescribeZones') return { ok: true, json: async () => ({ Zones: { Zone: [] } }) } as Response;
      if (action === 'DescribePrice') {
        const id = params.get('InstanceType')!;
        quotes.push(id);
        return { ok: true, json: async () => ({ PriceInfo: { Price: { TradePrice: id === 'ecs.exact-b' ? 0.1 : 0.2 } } }) } as Response;
      }
      throw new Error('Unexpected scheduling request');
    });
    const input = { regionId: 'cn-test', defaultZoneId: 'zone', account: { accessKeyId: 'test', accessKeySecret: 'test' },
      hostRequests: [{ hostKey: 'source', cpu, memoryGiB, exactResources: true, preferredInstanceTypes: ['ecs.larger'], networkInterfaceCount: 2 }] };
    expect((await selectZoneAndHostInstanceTypes(input)).hostInstanceTypes).toEqual({ source: 'ecs.exact-b' });
    expect(quotes).toEqual(['ecs.exact-a', 'ecs.exact-b']);
    input.hostRequests[0].networkInterfaceCount = 3;
    await expect(selectZoneAndHostInstanceTypes(input)).rejects.toThrow('no exact saleable X86 on-demand match');
  });

  it('finds an exact instance type beyond the first page using the official token pagination', async () => {
    const requests: URLSearchParams[] = [];
    jest.spyOn(global, 'fetch').mockImplementation(async value => {
      const params = new URL(String(value)).searchParams;
      if (params.get('Action') === 'DescribeInstanceTypes') {
        requests.push(params);
        return { ok: true, json: async () => params.get('NextToken') ? {
          InstanceTypes: { InstanceType: [{ InstanceTypeId: 'ecs.exact', CpuArchitecture: 'x86_64', CpuCoreCount: 1, MemorySize: 2, EniQuantity: 2 }] },
        } : { InstanceTypes: { InstanceType: [] }, NextToken: 'page-two' } } as Response;
      }
      if (params.get('Action') === 'DescribeAvailableResource') return { ok: true, json: async () => ({
        AvailableZones: { AvailableZone: { AvailableResources: { AvailableResource: { Type: 'InstanceType',
          SupportedResources: { SupportedResource: [{ Value: 'ecs.exact', Status: 'Available' }] } } } } },
      }) } as Response;
      if (params.get('Action') === 'DescribePrice') return { ok: true, json: async () => ({ PriceInfo: { Price: { TradePrice: 0.1 } } }) } as Response;
      throw new Error('Unexpected scheduling request');
    });
    const result = await selectZoneAndHostInstanceTypes({
      regionId: 'test', defaultZoneId: 'test-zone', account: { accessKeyId: 'test', accessKeySecret: 'test' },
      hostRequests: [{ hostKey: 'host', cpu: 1, memoryGiB: 2, exactResources: true, preferredInstanceTypes: [] }],
    });
    expect(result.hostInstanceTypes).toEqual({ host: 'ecs.exact' });
    expect(requests).toHaveLength(2);
    expect(requests[0].get('MaxResults')).toBe('100');
    expect(requests[0].has('PageNumber')).toBe(false);
    expect(requests[1].get('NextToken')).toBe('page-two');
  });

  it('rejects a repeated instance-type token rather than accepting an incomplete catalogue', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ InstanceTypes: { InstanceType: [] }, NextToken: 'same' }) } as Response);
    await expect(selectZoneAndHostInstanceTypes({
      regionId: 'test', defaultZoneId: 'test-zone', account: { accessKeyId: 'test', accessKeySecret: 'test' },
      hostRequests: [{ hostKey: 'host', cpu: 1, memoryGiB: 2, exactResources: true, preferredInstanceTypes: [] }],
    })).rejects.toThrow('Repeated ECS instance-type pagination token');
  });

  it('reuses quotes across hosts and bounds candidate reads while preserving same-price order', async () => {
    const types = ['ecs.a', 'ecs.b', 'ecs.c', 'ecs.d', 'ecs.e'];
    let active = 0;
    let maximum = 0;
    const fetchMock = mockScheduling({
      types,
      available: { default: [], fallback: types },
      zones: ['fallback'],
      quote: async (params) => {
        active++;
        maximum = Math.max(maximum, active);
        try {
          await new Promise((resolve) => setTimeout(resolve, (types.length - types.indexOf(params.get('InstanceType')!)) * 5));
          return 0.2;
        } finally {
          active--;
        }
      },
    });
    const result = await selectZoneAndHostInstanceTypes(request(types, 4));

    expect(result.hostInstanceTypes).toEqual({ host0: 'ecs.a', host1: 'ecs.a', host2: 'ecs.a', host3: 'ecs.a' });
    expect(result.attemptedZones[1]).toMatchObject({ estimatedTotalPrice: 0.8 });
    expect(actionCalls(fetchMock, 'DescribePrice')).toHaveLength(types.length);
    expect(maximum).toBe(3);
    expect(active).toBe(0);
  });

  it('keeps default-zone ordinary hosts on the unpriced fast path', async () => {
    const types = ['ecs.b', 'ecs.a'];
    const fetchMock = mockScheduling({ types, available: { default: types }, quote: async () => 0.1 });
    const result = await selectZoneAndHostInstanceTypes(request(types, 2));

    expect(result.selectedZoneId).toBe('default');
    expect(result.hostInstanceTypes).toEqual({ host0: 'ecs.b', host1: 'ecs.b' });
    expect(actionCalls(fetchMock, 'DescribePrice')).toHaveLength(0);
    expect(actionCalls(fetchMock, 'DescribeZones')).toHaveLength(0);
  });

  it('keeps fallback discovery order and preferred candidate order when prices tie', async () => {
    const types = ['ecs.b', 'ecs.a'];
    const fetchMock = mockScheduling({
      types, available: { default: [], zoneB: types, zoneA: types }, zones: ['zoneB', 'zoneA'],
      quote: async (params) => {
        if (params.get('InstanceType') === 'ecs.b') await new Promise((resolve) => setTimeout(resolve, 5));
        return 0.2;
      },
    });
    const result = await selectZoneAndHostInstanceTypes(request(types, 2));

    expect(result.selectedZoneId).toBe('zoneB');
    expect(result.hostInstanceTypes).toEqual({ host0: 'ecs.b', host1: 'ecs.b' });
    expect(result.attemptedZones.map((zone) => zone.zoneId)).toEqual(['default', 'zoneB', 'zoneA']);
    expect(actionCalls(fetchMock, 'DescribePrice')).toHaveLength(4);
  });

  it('preserves missing-price fallback and prefers a zone with known prices', async () => {
    const types = ['ecs.b', 'ecs.a'];
    const fetchMock = mockScheduling({
      types, available: { default: [], unavailablePrice: types, priced: types }, zones: ['unavailablePrice', 'priced'],
      quote: async (params) => {
        if (params.get('ZoneId') === 'unavailablePrice') throw new Error('price temporarily unavailable');
        return params.get('InstanceType') === 'ecs.a' ? 0.1 : 0.2;
      },
    });
    const result = await selectZoneAndHostInstanceTypes(request(types, 2));

    expect(result.selectedZoneId).toBe('priced');
    expect(result.hostInstanceTypes).toEqual({ host0: 'ecs.a', host1: 'ecs.a' });
    expect(result.attemptedZones[1]).toMatchObject({ canCreateAllHosts: true, estimatedTotalPrice: null, reason: 'Missing price data for one or more host candidates' });
    expect(result.attemptedZones[2].estimatedTotalPrice).toBe(0.2);
    expect(actionCalls(fetchMock, 'DescribePrice')).toHaveLength(4);
  });

  it('still rejects a multi-NIC zone whose candidates all lack prices', async () => {
    const types = ['ecs.a', 'ecs.b'];
    const fetchMock = mockScheduling({ types, available: { default: types }, zones: ['default'], quote: async () => null });
    const input = request(types);
    input.hostRequests[0].networkInterfaceCount = 3;

    await expect(selectZoneAndHostInstanceTypes(input)).rejects.toThrow('no priceable candidate compatible with the selected system disk');
    expect(actionCalls(fetchMock, 'DescribePrice')).toHaveLength(2);
  });

  it('never shares quote results between concurrent accounts or later disk configurations', async () => {
    const types = ['ecs.a', 'ecs.b'];
    const fetchMock = mockScheduling({
      types, available: { default: [], fallback: types }, zones: ['fallback'],
      quote: async (params) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        const chooseA = params.get('AccessKeyId') === 'account-a' && params.get('SystemDiskCategory') === 'cloud_essd';
        return (params.get('InstanceType') === 'ecs.a') === chooseA ? 0.1 : 0.2;
      },
    });
    const accountA = { ...request(types, 2), account: { accessKeyId: 'account-a', accessKeySecret: 'fake-a' } };
    const accountB = { ...request(types, 2), account: { accessKeyId: 'account-b', accessKeySecret: 'fake-b' } };
    const [a, b] = await Promise.all([selectZoneAndHostInstanceTypes(accountA), selectZoneAndHostInstanceTypes(accountB)]);
    const diskChanged = await selectZoneAndHostInstanceTypes({ ...accountA, systemDiskCategory: 'cloud_ssd' });

    expect(a.hostInstanceTypes).toEqual({ host0: 'ecs.a', host1: 'ecs.a' });
    expect(b.hostInstanceTypes).toEqual({ host0: 'ecs.b', host1: 'ecs.b' });
    expect(diskChanged.hostInstanceTypes).toEqual({ host0: 'ecs.b', host1: 'ecs.b' });
    expect(actionCalls(fetchMock, 'DescribePrice')).toHaveLength(6);
  });
});

function request(types: string[], hosts = 1) {
  return {
    regionId: 'cn-hangzhou', defaultZoneId: 'default', systemDiskCategory: 'cloud_essd',
    account: { accessKeyId: 'test-ak', accessKeySecret: 'test-sk' },
    hostRequests: Array.from({ length: hosts }, (_, index) => ({
      hostKey: `host${index}`, cpu: 2, memoryGiB: 4, preferredInstanceTypes: types, networkInterfaceCount: 1,
    })),
  };
}

function mockScheduling(input: {
  types: string[];
  available: Record<string, string[]>;
  zones?: string[];
  quote: (params: URLSearchParams) => Promise<number | null>;
}) {
  return jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
    const params = new URL(String(url)).searchParams;
    let payload: unknown;
    switch (params.get('Action')) {
      case 'DescribeInstanceTypes':
        payload = { TotalCount: input.types.length, InstanceTypes: { InstanceType: input.types.map((InstanceTypeId) => ({
          InstanceTypeId, CpuArchitecture: 'x86_64', CpuCoreCount: 2, MemorySize: 4, EniQuantity: 3,
        })) } };
        break;
      case 'DescribeAvailableResource':
        payload = { AvailableZones: { AvailableZone: { AvailableResources: { AvailableResource: {
          Type: 'InstanceType', SupportedResources: { SupportedResource: (input.available[params.get('ZoneId')!] ?? []).map((Value) => ({ Value, Status: 'Available' })) },
        } } } } };
        break;
      case 'DescribeZones':
        payload = { Zones: { Zone: (input.zones ?? []).map((ZoneId) => ({ ZoneId, Status: 'Available' })) } };
        break;
      case 'DescribePrice': {
        const price = await input.quote(params);
        payload = { PriceInfo: { Price: price === null ? {} : { TradePrice: price } } };
        break;
      }
      default:
        throw new Error('Unexpected mocked scheduling action');
    }
    return { ok: true, json: async () => payload } as Response;
  });
}

function actionCalls(fetchMock: { mock: { calls: unknown[][] } }, action: string) {
  return fetchMock.mock.calls.filter(([url]) => new URL(String(url)).searchParams.get('Action') === action);
}
