import {
  buildAliyunTagParameters,
  buildBillingTags,
  parseAliyunBillingTags,
  parsePlatformBillingTags,
} from '../src/admin/billing-tagging';

describe('buildBillingTags', () => {
  it('builds stable tags for user-owned resources', () => {
    expect(
      buildBillingTags({
        billingScope: 'user',
        ownerUserId: 'user-1',
        rangeInstanceId: 'range-1',
        billingStartAt: '2026-07-16',
      }),
    ).toEqual({
      CreatedBy: 'cyber-range-platform',
      PlatformScope: 'user',
      PlatformUserId: 'user-1',
      RangeInstanceId: 'range-1',
      BillingStartAt: '2026-07-16',
    });
  });

  it('omits empty optional business ids', () => {
    expect(
      buildBillingTags({
        billingScope: 'platform',
        ownerUserId: '   ',
        singleInstanceBatchId: '',
        platformImageAssetId: null,
        billingStartAt: new Date('2026-07-16T08:00:00.000Z'),
      }),
    ).toEqual({
      CreatedBy: 'cyber-range-platform',
      PlatformScope: 'platform',
      BillingStartAt: '2026-07-16',
    });
  });

  it('expands tags into aliyun rpc parameters', () => {
    expect(
      buildAliyunTagParameters({
        CreatedBy: 'cyber-range-platform',
        PlatformScope: 'user',
      }),
    ).toEqual({
      'Tag.1.Key': 'CreatedBy',
      'Tag.1.Value': 'cyber-range-platform',
      'Tag.2.Key': 'PlatformScope',
      'Tag.2.Value': 'user',
    });
  });

  it('parses platform billing tags from BSS bill text', () => {
    const value =
      'key:RangeInstanceId value:range-1; key:CreatedBy value:cyber-range-platform; key:PlatformUserId value:user-1; key:BillingStartAt value:2026-07-16; key:PlatformScope value:user';

    expect(parseAliyunBillingTags(value)).toEqual({
      RangeInstanceId: 'range-1',
      CreatedBy: 'cyber-range-platform',
      PlatformUserId: 'user-1',
      BillingStartAt: '2026-07-16',
      PlatformScope: 'user',
    });
    expect(parsePlatformBillingTags(value)).toEqual({
      billingScope: 'user',
      ownerUserId: 'user-1',
      rangeInstanceId: 'range-1',
      singleInstanceBatchId: null,
      platformImageAssetId: null,
      billingStartAt: '2026-07-16',
      tags: {
        RangeInstanceId: 'range-1',
        CreatedBy: 'cyber-range-platform',
        PlatformUserId: 'user-1',
        BillingStartAt: '2026-07-16',
        PlatformScope: 'user',
      },
    });
  });
});
