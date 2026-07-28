import { describe, expect, it } from 'vitest';
import {
  isAlibabaCloudPortRange,
  normalizeAlibabaCloudPortRange,
} from '@aliyun-cyber-range/scenario-runtime';

describe('Alibaba Cloud port range normalization', () => {
  it('converts the full-port range regardless of protocol without changing specific ranges', () => {
    expect(normalizeAlibabaCloudPortRange('1/65535', 'all')).toBe('-1/-1');
    expect(normalizeAlibabaCloudPortRange('1/65535', 'tcp')).toBe('-1/-1');
    expect(normalizeAlibabaCloudPortRange('1/65535', 'udp')).toBe('-1/-1');
    expect(normalizeAlibabaCloudPortRange('80/80', 'tcp')).toBe('80/80');
    expect(isAlibabaCloudPortRange('1/65535', 'tcp')).toBe(true);
  });

  it('requires the wildcard range for all and ICMP rules', () => {
    expect(isAlibabaCloudPortRange('1/65535', 'all')).toBe(true);
    expect(isAlibabaCloudPortRange('8/8', 'icmp')).toBe(false);
  });

  it('rejects malformed and out-of-range values', () => {
    expect(isAlibabaCloudPortRange('1-70000', 'tcp')).toBe(false);
    expect(isAlibabaCloudPortRange('80', 'tcp')).toBe(false);
  });
});
