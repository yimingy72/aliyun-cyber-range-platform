import {
  assertIpv4AddressInCidr,
  DEFAULT_ALIBABA_CLOUD_SECONDARY_VPC_CIDRS,
  resolveAlibabaCloudVpcCidrs,
} from '../src/provisioning/alibaba-cloud-vpc-cidrs';

describe('resolveAlibabaCloudVpcCidrs', () => {
  it('always creates the two fixed attached CIDRs', () => {
    expect(
      resolveAlibabaCloudVpcCidrs({
        vpcCidr: '10.0.0.0/16',
        networkZoneCidrs: ['10.0.20.0/24', '172.16.10.0/24', '192.168.50.0/24'],
      }),
    ).toEqual(DEFAULT_ALIBABA_CLOUD_SECONDARY_VPC_CIDRS);
  });

  it.each(['172.20.88.0/24', '10.10.20.0/24'])(
    'rejects a switch CIDR outside the fixed VPC networks: %s',
    (networkZoneCidr) => {
      expect(() =>
        resolveAlibabaCloudVpcCidrs({
          vpcCidr: '10.0.0.0/16',
          networkZoneCidrs: [networkZoneCidr],
        }),
      ).toThrow('不属于固定 VPC 网段');
    },
  );

  it('reports every switch CIDR outside the fixed VPC networks', () => {
    expect(() =>
      resolveAlibabaCloudVpcCidrs({
        vpcCidr: '10.0.0.0/16',
        networkZoneCidrs: ['192.168.50.0/24', '172.16.10.0/24', '172.20.88.0/24', '10.10.20.0/24'],
      }),
    ).toThrow('172.20.88.0/24、10.10.20.0/24 不属于固定 VPC 网段');
  });

  it('rejects overlapping switch networks before provisioning', () => {
    expect(() =>
      resolveAlibabaCloudVpcCidrs({
        vpcCidr: '10.0.0.0/16',
        networkZoneCidrs: ['10.0.10.0/24', '10.0.10.0/25'],
      }),
    ).toThrow('交换机网段 10.0.10.0/24 与 10.0.10.0/25 重叠');
  });

  it('rejects a primary VPC CIDR that conflicts with the fixed attached networks', () => {
    expect(() =>
      resolveAlibabaCloudVpcCidrs({
        vpcCidr: '172.16.0.0/16',
        networkZoneCidrs: ['172.16.10.0/24'],
      }),
    ).toThrow('与默认附加 VPC CIDR 172.16.0.0/16 重叠');
  });

  it('rejects a host private IP outside its switch CIDR', () => {
    expect(() =>
      assertIpv4AddressInCidr('10.0.30.10', '10.0.20.0/24', 'Host data-1 private IP'),
    ).toThrow('Host data-1 private IP 10.0.30.10 不属于交换机网段 10.0.20.0/24');
  });
});
