const PORT_RANGE_PATTERN = /^(-?\d{1,5})\/(-?\d{1,5})$/;

/**
 * Treat the UI's full-port range as Alibaba Cloud's wildcard range.
 */
export function normalizeAlibabaCloudPortRange(portRange: string, _protocol: string): string {
  const value = portRange.trim();

  if (value === '1/65535') {
    return '-1/-1';
  }

  return value;
}

export function isAlibabaCloudPortRange(portRange: string, protocol: string): boolean {
  const normalizedProtocol = protocol.trim().toLowerCase();
  const value = normalizeAlibabaCloudPortRange(portRange, protocol);

  if (normalizedProtocol === 'all' || normalizedProtocol === 'icmp') {
    return value === '-1/-1';
  }

  if (value === '-1/-1') {
    return true;
  }

  const match = value.match(PORT_RANGE_PATTERN);

  if (!match) {
    return false;
  }

  const start = Number(match[1]);
  const end = Number(match[2]);

  return (
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    start >= 1 &&
    start <= end &&
    end <= 65535
  );
}
