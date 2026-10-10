export type DnsInterfaceView = { nicId: string; privateIp: string; servers: string[] };
export type RangeDnsVerification = {
  status: 'pending' | 'checking' | 'verified' | 'failed' | 'unverified';
  method: 'readback' | 'ad_srv';
  expected: DnsInterfaceView[];
  actual: DnsInterfaceView[];
  resolutionStatus: 'not_requested' | 'verified' | 'failed';
  errorCode?: string;
  checkedAt?: string;
  instanceId: string;
  policyHash: string;
  claimId: string;
  expiresAt: string;
  invocationId?: string;
  cloudRequestId?: string;
};

export function publicDnsVerification(entries: Record<string, RangeDnsVerification> | undefined) {
  return entries && Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, {
    status: value.status === 'checking' && new Date(value.expiresAt).getTime() <= Date.now() ? 'unverified' : value.status, method: value.method, expected: value.expected, actual: value.actual,
    resolutionStatus: value.resolutionStatus, errorCode: value.status === 'checking' && new Date(value.expiresAt).getTime() <= Date.now() ? 'DNS_COMMAND_INTERRUPTED' : value.errorCode, checkedAt: value.checkedAt,
  }]));
}
