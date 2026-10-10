import type { AdminRepository, CloudProvider, RangeResourceSummary } from '../../src/admin/admin.repository';
import type { SystemConfigService } from '../../src/admin/system-config.service';
import { TencentBillingClient } from '../../src/admin/tencent-billing-client';
import { BillingSyncService } from '../../src/admin/billing-sync.service';
import type { BillingBssClient } from '../../src/admin/billing-bss-client';

export const TENCENT_BILLING_DAY = '2026-09-30';
export const TENCENT_BILLING_WINDOW = { startAt: TENCENT_BILLING_DAY, endAt: TENCENT_BILLING_DAY };
export const tencentBillingContext = { provider: 'tencent_cloud' as const, accountUid: '100001', accountUidResolved: true,
  accessKeyId: 'fixture-key', accessKeySecret: 'fixture-secret', defaultRegion: 'ap-shanghai', defaultZone: 'ap-shanghai-1' };
export function tencentBill(overrides: Record<string, unknown> = {}) {
  return { Id: 'official-1', OwnerUin: '100001', PayerUin: '100001', BillDay: `${TENCENT_BILLING_DAY} 00:00:00`,
    BillMonth: '2026-09-01 00:00:00', ResourceId: 'ins-owned', RegionId: '4', BusinessCode: 'p_cvm', ProductCode: 'sp_cvm_s5',
    ActionType: 'postpay_deduct_h', ComponentSet: [{ ComponentCode: 'v_cvm_cpu', ItemCode: 'sv_cvm_cpu', RealCost: '0.100000001',
      Cost: '999', CashPayAmount: '99', VoucherPayAmount: '10', IncentivePayAmount: '5' },
      { ComponentCode: 'v_cvm_rootdisk', ItemCode: 'sv_cvm_rootdisk_cbspremium', RealCost: '0.200000002' }], ...overrides };
}
export function signedTencentBillingResponse(rows: Record<string, unknown>[], extras: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ Response: { RequestId: 'fixture-request', DetailSet: rows, Total: rows.length, ...extras } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } });
}
export function tencentBillingSync(repository: AdminRepository, context = tencentBillingContext) {
  const config = { getExecutionAccountContext: async () => ({ ...context }) } as unknown as SystemConfigService;
  const bss = { listDailyBillingItems: jest.fn(() => { throw new Error('Tencent must not call Aliyun BSS'); }) } as unknown as BillingBssClient;
  return new BillingSyncService(repository, bss, config, new TencentBillingClient());
}
export async function createTencentBillingProof(repository: AdminRepository, options: { provider?: CloudProvider; uid?: string; ownerUserId?: string; summary?: RangeResourceSummary } = {}) {
  const provider = options.provider ?? 'tencent_cloud';
  const uid = options.uid ?? '100001';
  const summary = options.summary ?? { mode: 'opentofu', executionContext: { provider, cloudAccountContextId: 'fixture-context',
    cloudAccountUid: uid, regionId: 'ap-shanghai', zoneId: 'ap-shanghai-1' },
    hostIds: { host: 'ins-owned' }, systemDiskIds: { host: 'disk-system' }, dataDiskIds: { data: 'disk-data' },
    eipAllocationIds: { public: 'eip-owned' }, natGatewayIds: { edge: 'nat-owned' } };
  const instance = await repository.createRangeInstance({ name: 'billing-proof', cloudProvider: provider,
    ownerUserId: options.ownerUserId, resourceSummary: summary });
  const job = await repository.createProvisionJob({ rangeInstanceId: instance.id, jobType: 'create', triggeredBy: options.ownerUserId ?? 'fixture-admin' });
  if (provider === 'tencent_cloud') {
    const resources = ([['hostIds','ecs'],['systemDiskIds','disk'],['dataDiskIds','disk'],['eipAllocationIds','eip'],['natGatewayIds','nat_gateway']] as const)
      .flatMap(([field,cloudResourceType])=>Object.values(summary[field] ?? {}).map(cloudResourceId=>({cloudResourceId,cloudResourceType})));
    const context=summary.executionContext;
    await repository.createProvisionJobStepLog({jobId:job.id,stepName:'platform_billing_creation_inventory',status:'succeeded',message:JSON.stringify({version:1,
      cloudProvider:'tencent_cloud',cloudWorkspaceId:instance.cloudWorkspaceId ?? 'legacy-unbound',rangeInstanceId:instance.id,sourceJobId:job.id,ownerUserId:instance.ownerUserId ?? null,
      executionContext:context ? {provider:context.provider,cloudAccountContextId:context.cloudAccountContextId,cloudAccountUid:context.cloudAccountUid,regionId:context.regionId,zoneId:context.zoneId} : null,
      resources,diskAttachments:{}}),startedAt:new Date(),finishedAt:new Date(),stdoutExcerpt:null,stderrExcerpt:null});
  }
  const ledgers = await Promise.all(([['ins-owned', 'ecs'], ['disk-system', 'disk'], ['disk-data', 'disk'], ['eip-owned', 'eip'], ['nat-owned', 'nat_gateway']] as const)
    .map(([cloudResourceId, cloudResourceType]) => repository.createBillingLedgerResource({ cloudProvider: provider, cloudAccountUid: uid,
      regionId: 'ap-shanghai', cloudResourceId, cloudResourceType, billingScope: options.ownerUserId ? 'user' : 'platform',
      ownerUserId: options.ownerUserId, rangeInstanceId: instance.id, sourceProvisionJobId: job.id, billingStartAt: new Date('2026-09-01') })));
  return { instance, job, ledgers };
}
