import { classifyBillLine } from '../src/admin/billing-classifier';

describe('classifyBillLine', () => {
  it('classifies direct ecs configuration charges', () => {
    expect(
      classifyBillLine({
        ProductCode: 'ecs',
        BillingItem: '云服务器配置',
        InstanceID: 'i-abc',
      }),
    ).toEqual({
      kind: 'direct',
      cloudResourceId: 'i-abc',
      cloudResourceType: 'ecs',
    });
  });

  it('classifies snapshot chain capacity as an aggregated regional charge', () => {
    expect(
      classifyBillLine({
        ProductCode: 'snapshot',
        BillingItem: '快照链容量',
        InstanceID: 'cn-hangzhou',
      }),
    ).toEqual({
      kind: 'aggregated',
      cloudResourceId: 'cn-hangzhou',
      cloudResourceType: 'snapshot_region',
    });
  });

  it('classifies eip retain charges directly by allocation id', () => {
    expect(
      classifyBillLine({
        ProductCode: 'eip',
        BillingItem: '公网IP保有费',
        InstanceID: 'eip-123',
      }),
    ).toEqual({
      kind: 'direct',
      cloudResourceId: 'eip-123',
      cloudResourceType: 'eip',
    });
  });

  it('marks shared-account oss charges as deferred from v1 attribution', () => {
    expect(
      classifyBillLine({
        ProductCode: 'oss',
        BillingItem: '外网流出流量',
        InstanceID: 'cn-hangzhou;standard-zrs',
      }),
    ).toEqual({
      kind: 'deferred',
      cloudResourceId: 'cn-hangzhou;standard-zrs',
      cloudResourceType: 'unknown',
      reason: 'OSS 账单暂不纳入当前版本的归属范围，待明确独立所有权边界后再处理。',
    });
  });
});
