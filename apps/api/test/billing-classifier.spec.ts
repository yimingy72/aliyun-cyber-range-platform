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

  it('classifies snapshot chain capacity as an account-level aggregate', () => {
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

  it('classifies snapshot chain capacity by a concrete snapshot id directly', () => {
    expect(
      classifyBillLine({
        ProductCode: 'snapshot',
        BillingItem: '快照链容量',
        InstanceID: 's-platform-1',
      }),
    ).toEqual({
      kind: 'direct',
      cloudResourceId: 's-platform-1',
      cloudResourceType: 'snapshot',
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

  it('classifies image charges directly by image id', () => {
    expect(
      classifyBillLine({
        ProductCode: 'image',
        BillingItem: '镜像存储',
        InstanceID: 'm-platform-image',
      }),
    ).toEqual({
      kind: 'direct',
      cloudResourceId: 'm-platform-image',
      cloudResourceType: 'image',
    });
  });

  it('classifies OSS storage and traffic charges as account-level aggregates', () => {
    expect(
      classifyBillLine({
        ProductCode: 'oss',
        BillingItem: '外网流出流量',
        InstanceID: 'cn-hangzhou;standard-zrs',
      }),
    ).toEqual({
      kind: 'aggregated',
      cloudResourceId: 'cn-hangzhou;standard-zrs',
      cloudResourceType: 'unknown',
    });
  });
});
