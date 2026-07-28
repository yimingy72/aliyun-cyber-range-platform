export const DEFAULT_ALIBABA_CLOUD_SECONDARY_VPC_CIDRS = [
  '172.16.0.0/16',
  '192.168.0.0/16',
] as const;

type ParsedIpv4Cidr = {
  value: string;
  start: number;
  end: number;
};

type ResolveAlibabaCloudVpcCidrsInput = {
  vpcCidr: string;
  networkZoneCidrs: string[];
};

export function resolveAlibabaCloudVpcCidrs(
  input: ResolveAlibabaCloudVpcCidrsInput,
): string[] {
  const primaryVpcCidr = parseIpv4Cidr(input.vpcCidr, 'VPC CIDR');
  assertPrivateCidr(primaryVpcCidr, 'VPC CIDR');
  const secondaryVpcCidrs = DEFAULT_ALIBABA_CLOUD_SECONDARY_VPC_CIDRS.map((cidr) =>
    parseIpv4Cidr(cidr, '附加 VPC CIDR'),
  );
  const networkZoneCidrs = input.networkZoneCidrs.map((cidr, index) =>
    parseIpv4Cidr(cidr, `交换机网段 ${index + 1}`),
  );

  for (const secondaryVpcCidr of secondaryVpcCidrs) {
    if (overlaps(primaryVpcCidr, secondaryVpcCidr)) {
      throw new Error(
        `VPC CIDR ${primaryVpcCidr.value} 与默认附加 VPC CIDR ${secondaryVpcCidr.value} 重叠`,
      );
    }
  }

  assertNetworkZonesDoNotOverlap(networkZoneCidrs);

  const invalidNetworkZoneCidrs = networkZoneCidrs.filter(
    (networkZoneCidr) =>
      !contains(primaryVpcCidr, networkZoneCidr) &&
      !secondaryVpcCidrs.some((cidr) => contains(cidr, networkZoneCidr)),
  );

  if (invalidNetworkZoneCidrs.length > 0) {
    throw new Error(
      `交换机网段 ${invalidNetworkZoneCidrs.map((cidr) => cidr.value).join('、')} 不属于固定 VPC 网段（${[
        primaryVpcCidr.value,
        ...DEFAULT_ALIBABA_CLOUD_SECONDARY_VPC_CIDRS,
      ].join('、')}）`,
    );
  }

  return [...DEFAULT_ALIBABA_CLOUD_SECONDARY_VPC_CIDRS];
}

export function assertIpv4AddressInCidr(
  ipAddress: string,
  cidr: string,
  fieldName: string,
) {
  const address = parseIpv4Address(ipAddress, fieldName);
  const parsedCidr = parseIpv4Cidr(cidr, '交换机网段');

  if (address < parsedCidr.start || address > parsedCidr.end) {
    throw new Error(`${fieldName} ${ipAddress} 不属于交换机网段 ${parsedCidr.value}`);
  }
}

function assertNetworkZonesDoNotOverlap(networkZoneCidrs: ParsedIpv4Cidr[]) {
  for (let index = 0; index < networkZoneCidrs.length; index += 1) {
    const current = networkZoneCidrs[index]!;

    for (const candidate of networkZoneCidrs.slice(index + 1)) {
      if (overlaps(current, candidate)) {
        throw new Error(`交换机网段 ${current.value} 与 ${candidate.value} 重叠`);
      }
    }
  }
}

function assertPrivateCidr(cidr: ParsedIpv4Cidr, fieldName: string) {
  const firstOctet = Math.floor(cidr.start / 2 ** 24);
  const secondOctet = Math.floor(cidr.start / 2 ** 16) % 256;
  const isPrivateRange =
    firstOctet === 10 ||
    (firstOctet === 172 && secondOctet >= 16 && secondOctet <= 31) ||
    (firstOctet === 192 && secondOctet === 168);

  if (!isPrivateRange) {
    throw new Error(`${fieldName} ${cidr.value} 不属于阿里云支持的私有 IPv4 地址范围`);
  }
}

function parseIpv4Cidr(value: string, fieldName: string): ParsedIpv4Cidr {
  const [ipAddress, prefixText, ...extraSegments] = value.trim().split('/');

  if (!ipAddress || !prefixText || extraSegments.length > 0) {
    throw new Error(`${fieldName} 必须是 IPv4 CIDR`);
  }

  const octets = ipAddress.split('.').map((segment) => Number(segment));
  const prefixLength = Number(prefixText);

  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255) ||
    !Number.isInteger(prefixLength) ||
    prefixLength < 0 ||
    prefixLength > 32
  ) {
    throw new Error(`${fieldName} 必须是 IPv4 CIDR`);
  }

  const address = octets.reduce((result, octet) => result * 256 + octet, 0);
  const start = (address & createMask(prefixLength)) >>> 0;

  if (address !== start) {
    throw new Error(`${fieldName} 必须使用网络地址`);
  }

  return {
    value: `${octets.join('.')}/${prefixLength}`,
    start,
    end: start + 2 ** (32 - prefixLength) - 1,
  };
}

function parseIpv4Address(value: string, fieldName: string) {
  const octets = value.trim().split('.').map((segment) => Number(segment));

  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    throw new Error(`${fieldName} 必须是 IPv4 地址`);
  }

  return octets.reduce((result, octet) => result * 256 + octet, 0);
}

function createMask(prefixLength: number) {
  if (prefixLength === 0) {
    return 0;
  }

  return (0xffffffff << (32 - prefixLength)) >>> 0;
}

function contains(parent: ParsedIpv4Cidr, child: ParsedIpv4Cidr) {
  return parent.start <= child.start && parent.end >= child.end;
}

function overlaps(left: ParsedIpv4Cidr, right: ParsedIpv4Cidr) {
  return left.start <= right.end && right.start <= left.end;
}
