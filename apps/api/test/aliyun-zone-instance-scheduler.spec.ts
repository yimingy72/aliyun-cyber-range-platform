import { selectZoneAndHostInstanceTypes } from '../src/provisioning/aliyun-zone-instance-scheduler';

describe('selectZoneAndHostInstanceTypes', () => {
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
});
