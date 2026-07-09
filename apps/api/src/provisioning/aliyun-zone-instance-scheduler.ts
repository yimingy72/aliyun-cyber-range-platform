import { createHmac, randomUUID } from 'node:crypto';

type HostRequest = {
  hostKey: string;
  cpu?: number;
  memoryGiB?: number;
  preferredInstanceTypes: string[];
};

type AttemptedZone = {
  zoneId: string;
  canCreateAllHosts: boolean;
  estimatedTotalPrice: number | null;
  reason?: string;
};

type ZoneEvaluation = AttemptedZone & {
  hostInstanceTypes: Record<string, string>;
};

const ALICLOUD_RPC_FORMAT = 'JSON';
const ALICLOUD_RPC_SIGNATURE_METHOD = 'HMAC-SHA1';
const ALICLOUD_RPC_SIGNATURE_VERSION = '1.0';
const ALICLOUD_RPC_API_VERSION = '2014-05-26';
const ALICLOUD_PAGE_SIZE = 100;

export async function selectZoneAndHostInstanceTypes(input: {
  regionId: string;
  defaultZoneId: string;
  systemDiskCategory?: string;
  hostRequests: HostRequest[];
  account: { accessKeyId: string; accessKeySecret: string };
}): Promise<{
  selectedZoneId: string;
  hostInstanceTypes: Record<string, string>;
  attemptedZones: AttemptedZone[];
}> {
  const instanceTypes = await describeInstanceTypes(input);
  const x86InstanceTypeIds = new Set(
    instanceTypes.filter((item) => isX86Architecture(item.architecture)).map((item) => item.instanceTypeId),
  );

  const defaultZoneEvaluation = await evaluateZone({
    ...input,
    zoneId: input.defaultZoneId,
    x86InstanceTypeIds,
    includePrice: false,
  });

  if (defaultZoneEvaluation.canCreateAllHosts) {
    return {
      selectedZoneId: defaultZoneEvaluation.zoneId,
      hostInstanceTypes: defaultZoneEvaluation.hostInstanceTypes,
      attemptedZones: [toAttemptedZone(defaultZoneEvaluation)],
    };
  }

  const discoveredZoneIds = await describeZones(input);
  const fallbackZoneIds = discoveredZoneIds.filter((zoneId) => zoneId !== input.defaultZoneId);
  const attemptedZones: AttemptedZone[] = [toAttemptedZone(defaultZoneEvaluation)];
  const fallbackEvaluations: ZoneEvaluation[] = [];

  for (const zoneId of fallbackZoneIds) {
    const evaluation = await evaluateZone({
      ...input,
      zoneId,
      x86InstanceTypeIds,
      includePrice: true,
    });
    attemptedZones.push(toAttemptedZone(evaluation));
    fallbackEvaluations.push(evaluation);
  }

  const selectedZone = [...fallbackEvaluations].sort(compareZoneEvaluations).find((zone) => zone.canCreateAllHosts);
  if (!selectedZone) {
    throw new Error(
      `No feasible ECS zone found in region ${input.regionId}. Attempted zones: ${attemptedZones
        .map((zone) => `${zone.zoneId}${zone.reason ? ` (${zone.reason})` : ''}`)
        .join(', ')}`,
    );
  }

  return {
    selectedZoneId: selectedZone.zoneId,
    hostInstanceTypes: selectedZone.hostInstanceTypes,
    attemptedZones,
  };
}

async function evaluateZone(input: {
  regionId: string;
  zoneId: string;
  systemDiskCategory?: string;
  hostRequests: HostRequest[];
  account: { accessKeyId: string; accessKeySecret: string };
  x86InstanceTypeIds: Set<string>;
  includePrice: boolean;
}): Promise<ZoneEvaluation> {
  const saleableInstanceTypeIds = new Set(await describeAvailableInstanceTypeIds(input));
  if (saleableInstanceTypeIds.size === 0) {
    return {
      zoneId: input.zoneId,
      canCreateAllHosts: false,
      estimatedTotalPrice: null,
      reason: 'No saleable X86 on-demand instance types',
      hostInstanceTypes: {},
    };
  }

  const hostInstanceTypes: Record<string, string> = {};
  let estimatedTotalPrice = 0;
  let hasMissingPrice = false;

  for (const host of input.hostRequests) {
    const preferredInstanceTypes = [...new Set(host.preferredInstanceTypes.map((item) => item.trim()).filter(Boolean))];
    const candidateInstanceTypes = preferredInstanceTypes.filter(
      (instanceTypeId) =>
        saleableInstanceTypeIds.has(instanceTypeId) && input.x86InstanceTypeIds.has(instanceTypeId),
    );

    if (candidateInstanceTypes.length === 0) {
      return {
        zoneId: input.zoneId,
        canCreateAllHosts: false,
        estimatedTotalPrice: null,
        reason: `Host ${host.hostKey} has no saleable X86 on-demand candidate`,
        hostInstanceTypes: {},
      };
    }

    if (!input.includePrice) {
      hostInstanceTypes[host.hostKey] = candidateInstanceTypes[0]!;
      continue;
    }

    let selectedInstanceType: string | null = null;
    let selectedPrice: number | null = null;

    for (const instanceTypeId of candidateInstanceTypes) {
      const price = await describeInstanceTypePrice({
        ...input,
        instanceTypeId,
      });

      if (price === null) {
        continue;
      }

      if (selectedPrice === null || price < selectedPrice) {
        selectedInstanceType = instanceTypeId;
        selectedPrice = price;
      }
    }

    if (!selectedInstanceType) {
      selectedInstanceType = candidateInstanceTypes[0]!;
      hasMissingPrice = true;
    }

    hostInstanceTypes[host.hostKey] = selectedInstanceType;
    if (selectedPrice === null) {
      hasMissingPrice = true;
      continue;
    }

    estimatedTotalPrice += selectedPrice;
  }

  return {
    zoneId: input.zoneId,
    canCreateAllHosts: true,
    estimatedTotalPrice: input.includePrice ? (hasMissingPrice ? null : estimatedTotalPrice) : null,
    ...(hasMissingPrice ? { reason: 'Missing price data for one or more host candidates' } : {}),
    hostInstanceTypes,
  };
}

async function describeAvailableInstanceTypeIds(input: {
  regionId: string;
  zoneId: string;
  systemDiskCategory?: string;
  account: { accessKeyId: string; accessKeySecret: string };
}) {
  const payload = await performAliyunRpcRequest({
    accessKeyId: input.account.accessKeyId,
    accessKeySecret: input.account.accessKeySecret,
    regionId: input.regionId,
    action: 'DescribeAvailableResource',
    parameters: {
      ZoneId: input.zoneId,
      DestinationResource: 'InstanceType',
      ResourceType: 'instance',
      InstanceChargeType: 'PostPaid',
      IoOptimized: 'optimized',
      NetworkCategory: 'vpc',
      ...(input.systemDiskCategory ? { SystemDiskCategory: input.systemDiskCategory } : {}),
    },
  });

  const availableZones = normalizeArray(
    (payload as {
      AvailableZones?: {
        AvailableZone?:
          | {
              AvailableResources?: {
                AvailableResource?:
                  | {
                      Type?: string;
                      SupportedResources?: {
                        SupportedResource?:
                          | {
                              Status?: string;
                              Value?: string;
                            }
                          | Array<{
                              Status?: string;
                              Value?: string;
                            }>;
                      };
                    }
                  | Array<{
                      Type?: string;
                      SupportedResources?: {
                        SupportedResource?:
                          | {
                              Status?: string;
                              Value?: string;
                            }
                          | Array<{
                              Status?: string;
                              Value?: string;
                            }>;
                      };
                    }>;
              };
            }
          | Array<{
              AvailableResources?: {
                AvailableResource?:
                  | {
                      Type?: string;
                      SupportedResources?: {
                        SupportedResource?:
                          | {
                              Status?: string;
                              Value?: string;
                            }
                          | Array<{
                              Status?: string;
                              Value?: string;
                            }>;
                      };
                    }
                  | Array<{
                      Type?: string;
                      SupportedResources?: {
                        SupportedResource?:
                          | {
                              Status?: string;
                              Value?: string;
                            }
                          | Array<{
                              Status?: string;
                              Value?: string;
                            }>;
                      };
                    }>;
              };
            }>;
      };
    })?.AvailableZones?.AvailableZone,
  );

  return [
    ...new Set(
      availableZones.flatMap((zone) =>
        normalizeArray(zone.AvailableResources?.AvailableResource)
          .filter((resource) => resource.Type === 'InstanceType')
          .flatMap((resource) => normalizeArray(resource.SupportedResources?.SupportedResource))
          .filter((resource) => resource.Status === 'Available' && typeof resource.Value === 'string')
          .map((resource) => resource.Value!.trim())
          .filter(Boolean),
      ),
    ),
  ];
}

async function describeZones(input: {
  regionId: string;
  account: { accessKeyId: string; accessKeySecret: string };
}) {
  const payload = await performAliyunRpcRequest({
    accessKeyId: input.account.accessKeyId,
    accessKeySecret: input.account.accessKeySecret,
    regionId: input.regionId,
    action: 'DescribeZones',
    parameters: {
      Verbose: 'true',
    },
  });

  const zones = normalizeArray(
    (payload as {
      Zones?: {
        Zone?:
          | {
              ZoneId?: string;
              Status?: string;
              AvailableResourceCreation?: string;
            }
          | Array<{
              ZoneId?: string;
              Status?: string;
              AvailableResourceCreation?: string;
            }>;
      };
    })?.Zones?.Zone,
  );

  return zones
    .filter(
      (zone) =>
        typeof zone.ZoneId === 'string' &&
        zone.ZoneId.trim().length > 0 &&
        (zone.Status ?? 'Available') === 'Available' &&
        (zone.AvailableResourceCreation ?? 'Supported') !== 'Unsupported',
    )
    .map((zone) => zone.ZoneId!.trim());
}

async function describeInstanceTypes(input: {
  regionId: string;
  account: { accessKeyId: string; accessKeySecret: string };
}) {
  const items: Array<{
    instanceTypeId: string;
    architecture: string;
  }> = [];
  let pageNumber = 1;
  let totalCount = 0;

  do {
    const payload = await performAliyunRpcRequest({
      accessKeyId: input.account.accessKeyId,
      accessKeySecret: input.account.accessKeySecret,
      regionId: input.regionId,
      action: 'DescribeInstanceTypes',
      parameters: {
        PageNumber: String(pageNumber),
        PageSize: String(ALICLOUD_PAGE_SIZE),
      },
    });

    const instanceTypes = normalizeArray(
      (payload as {
        TotalCount?: number | string;
        InstanceTypes?: {
          InstanceType?:
            | {
                InstanceTypeId?: string;
                CpuArchitecture?: string;
              }
            | Array<{
                InstanceTypeId?: string;
                CpuArchitecture?: string;
              }>;
        };
      })?.InstanceTypes?.InstanceType,
    );

    items.push(
      ...instanceTypes
        .map((item) => {
          const instanceTypeId = item.InstanceTypeId?.trim();
          if (!instanceTypeId) {
            return null;
          }

          return {
            instanceTypeId,
            architecture: item.CpuArchitecture?.trim().toUpperCase() ?? '',
          };
        })
        .filter((item): item is { instanceTypeId: string; architecture: string } => item !== null),
    );

    totalCount = toNumber((payload as { TotalCount?: number | string }).TotalCount);
    pageNumber += 1;
  } while ((pageNumber - 1) * ALICLOUD_PAGE_SIZE < totalCount);

  return items;
}

async function describeInstanceTypePrice(input: {
  regionId: string;
  zoneId: string;
  instanceTypeId: string;
  systemDiskCategory?: string;
  account: { accessKeyId: string; accessKeySecret: string };
}) {
  const payload = await performAliyunRpcRequest({
    accessKeyId: input.account.accessKeyId,
    accessKeySecret: input.account.accessKeySecret,
    regionId: input.regionId,
    action: 'DescribePrice',
    parameters: {
      ZoneId: input.zoneId,
      ResourceType: 'instance',
      InstanceType: input.instanceTypeId,
      InstanceChargeType: 'PostPaid',
      PriceUnit: 'Hour',
      ...(input.systemDiskCategory ? { SystemDiskCategory: input.systemDiskCategory } : {}),
    },
  });

  const priceRecord = (payload as {
    PriceInfo?: {
      Price?: {
        TradePrice?: number | string;
        OriginalPrice?: number | string;
      };
    };
  })?.PriceInfo?.Price;

  const tradePrice = toNumber(priceRecord?.TradePrice);
  if (tradePrice > 0) {
    return tradePrice;
  }

  const originalPrice = toNumber(priceRecord?.OriginalPrice);
  return originalPrice > 0 ? originalPrice : null;
}

async function performAliyunRpcRequest(input: {
  accessKeyId: string;
  accessKeySecret: string;
  regionId: string;
  action: string;
  parameters?: Record<string, string>;
}) {
  const endpoint = `https://ecs.${input.regionId}.aliyuncs.com/`;
  const query = signAliyunRpcQuery(
    {
      Action: input.action,
      AccessKeyId: input.accessKeyId,
      Format: ALICLOUD_RPC_FORMAT,
      RegionId: input.regionId,
      SignatureMethod: ALICLOUD_RPC_SIGNATURE_METHOD,
      SignatureNonce: randomUUID(),
      SignatureVersion: ALICLOUD_RPC_SIGNATURE_VERSION,
      Timestamp: formatAliyunTimestamp(new Date()),
      Version: ALICLOUD_RPC_API_VERSION,
      ...(input.parameters ?? {}),
    },
    input.accessKeySecret,
  );
  const response = await fetch(`${endpoint}?${query}`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
  });

  let payload: unknown = null;

  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const errorCode =
      payload && typeof payload === 'object' && 'Code' in payload && typeof (payload as { Code?: unknown }).Code === 'string'
        ? (payload as { Code: string }).Code
        : `HTTP_${response.status}`;
    const errorMessage =
      payload && typeof payload === 'object' && 'Message' in payload && typeof (payload as { Message?: unknown }).Message === 'string'
        ? (payload as { Message: string }).Message
        : `Aliyun RPC request failed with status ${response.status}`;

    throw new Error(`${input.action} failed: ${errorCode} - ${errorMessage}`);
  }

  return payload;
}

function compareZoneEvaluations(left: ZoneEvaluation, right: ZoneEvaluation) {
  if (left.canCreateAllHosts !== right.canCreateAllHosts) {
    return left.canCreateAllHosts ? -1 : 1;
  }

  if (left.canCreateAllHosts && right.canCreateAllHosts) {
    return (left.estimatedTotalPrice ?? Number.POSITIVE_INFINITY) - (right.estimatedTotalPrice ?? Number.POSITIVE_INFINITY);
  }

  return left.zoneId.localeCompare(right.zoneId);
}

function toAttemptedZone(zone: ZoneEvaluation): AttemptedZone {
  return {
    zoneId: zone.zoneId,
    canCreateAllHosts: zone.canCreateAllHosts,
    estimatedTotalPrice: zone.estimatedTotalPrice,
    ...(zone.reason ? { reason: zone.reason } : {}),
  };
}

function signAliyunRpcQuery(parameters: Record<string, string>, accessKeySecret: string) {
  const canonicalizedQuery = Object.entries(parameters)
    .sort(([leftKey], [rightKey]) => compareAliyunRpcKeys(leftKey, rightKey))
    .map(([key, value]) => `${percentEncodeAliyunRpc(key)}=${percentEncodeAliyunRpc(value)}`)
    .join('&');
  const stringToSign = `GET&${percentEncodeAliyunRpc('/')}&${percentEncodeAliyunRpc(canonicalizedQuery)}`;
  const signature = createHmac('sha1', `${accessKeySecret}&`).update(stringToSign).digest('base64');

  return `${canonicalizedQuery}&Signature=${percentEncodeAliyunRpc(signature)}`;
}

function percentEncodeAliyunRpc(value: string) {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%7E/g, '~');
}

function compareAliyunRpcKeys(leftKey: string, rightKey: string) {
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function formatAliyunTimestamp(value: Date) {
  return value.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function isX86Architecture(value: string) {
  return value.toUpperCase().includes('X86');
}

function toNumber(value: number | string | undefined) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function normalizeArray<T>(value: T | T[] | null | undefined) {
  if (!value) {
    return [] as T[];
  }

  return Array.isArray(value) ? value : [value];
}
