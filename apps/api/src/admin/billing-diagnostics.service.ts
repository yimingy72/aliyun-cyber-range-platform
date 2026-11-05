import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { ADMIN_REPOSITORY, type AdminRepository } from './admin.repository';
import { BillingBssClient, BillingRpcError, BillingSplitBillUnavailableError, type SplitBillingProduct } from './billing-bss-client';
import { SystemConfigService } from './system-config.service';
import { currentPlatformBillingProof, readPlatformBillingStartedAt } from './billing-current-scope';
import { isPlatformCreatedLedger, loadPlatformBillingProof } from './billing-platform-scope';
import { getCurrentCloudWorkspaceScope } from '../auth/cloud-workspace-scope';
import { billingDayText } from './billing-window';
import type { BillingQueryEvidence } from './billing-reconciliation-types';
import { cdtBillingIdentity } from './billing-classifier';
import { BillingDecimal } from './billing-amount';
import { readAliyunResourceConfigTimelines } from './aliyun-resource-config-timeline';

const productFields = ['ProductCode', 'ProductType', 'PipCode', 'CommodityCode', 'BillingItemCode', 'BillingItem', 'ProductName'];
const rowFields = [...productFields, 'InstanceID', 'SplitItemID', 'Currency', 'PretaxAmount', 'PretaxGrossAmount', 'InvoiceDiscount',
  'DeductedByCashCoupons', 'DeductedByResourcePackage', 'Usage', 'UsageUnit', 'ServicePeriod', 'ServicePeriodUnit', 'Item', 'Region', 'RegionId', 'ListPrice', 'ListPriceUnit'];

@Injectable()
export class BillingDiagnosticsService {
  constructor(@Inject(ADMIN_REPOSITORY) private readonly repository: AdminRepository, private readonly bss: BillingBssClient,
    private readonly config: SystemConfigService) {}

  async monthly(input: { billingCycle?: string; ledgerIds?: string } & Record<string, unknown>) {
    const cycle = input.billingCycle, ids = typeof input.ledgerIds === 'string' ? input.ledgerIds.split(',') : [];
    if (Object.keys(input).some(key => !['billingCycle', 'ledgerIds'].includes(key)) || typeof cycle !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(cycle)
      || !ids.length || ids.length > 100 || ids.some(id => !/^[A-Za-z0-9_-]{1,128}$/.test(id)) || new Set(ids).size !== ids.length)
      throw new BadRequestException('Select 1 to 100 exact ledger IDs and a billing cycle');
    const scope = getCurrentCloudWorkspaceScope();
    if (!scope || 'system' in scope || scope.provider !== 'alibaba_cloud' || !scope.accountUid) throw new ForbiddenException('Verified Alibaba workspace required');
    const proof = currentPlatformBillingProof(await loadPlatformBillingProof(this.repository), readPlatformBillingStartedAt());
    const ledgers = ids.map(id => proof.ledgers.find(row => row.id === id));
    if (ledgers.some(row => !row || row.cloudWorkspaceId !== scope.cloudWorkspaceId || row.cloudProvider !== scope.provider
      || row.cloudAccountUid !== scope.accountUid || !isPlatformCreatedLedger(row, proof))) throw new ForbiddenException('Ledger creation source is outside this workspace');
    const selected = ledgers.filter(row => row !== undefined);
    const contextIds = new Set(selected.map(row => row.tagsSnapshot.CloudAccountContextId));
    if (contextIds.size !== 1 || typeof [...contextIds][0] !== 'string' || ![...contextIds][0]) throw new ForbiddenException('Select resources from one original account context');
    if (cycle > billingDayText(new Date()).slice(0, 7) || selected.some(row => cycle < billingDayText(row.billingStartAt).slice(0, 7)
      || cycle > billingDayText(row.releasedAt ?? new Date()).slice(0, 7))) throw new BadRequestException('Billing cycle must overlap the recorded resource lifetime');
    const context = await this.config.getAccountContextById([...contextIds][0] as string);
    if (context.provider !== scope.provider || context.accountUid !== scope.accountUid || !context.accountUidResolved
      || selected.some(row => row.regionId !== context.defaultRegion)) throw new ForbiddenException('Original billing account context changed');
    const safe = (value: unknown) => {
      if (typeof value === 'string') return value.length <= 4096 && ![context.accessKeyId, context.accessKeySecret].some(secret => secret && value.includes(secret)) ? value : '[redacted]';
      return value === null || typeof value === 'number' || typeof value === 'boolean' ? value : '[invalid]';
    };
    const resources = selected.map(row => ({ ledgerId: row.id, cloudResourceId: row.cloudResourceId, cloudResourceType: row.cloudResourceType,
      rangeInstanceId: row.rangeInstanceId, sourceProvisionJobId: row.sourceProvisionJobId, billingStartAt: row.billingStartAt, releasedAt: row.releasedAt }));
    const queries = [];
    const splitProducts = new Set<SplitBillingProduct>(selected.flatMap(row => row.cloudResourceType === 'eip' ? ['eip', 'cdt', 'cbwp']
      : row.cloudResourceType === 'snapshot' ? ['snapshot'] : row.cloudResourceType === 'oss_bucket' ? ['oss'] : []) as SplitBillingProduct[]);
    const plans: Array<{ action: 'DescribeInstanceBill' | 'DescribeSplitItemBill'; productCode?: SplitBillingProduct }> = [
      { action: 'DescribeInstanceBill' }, ...[...splitProducts].map(productCode => ({ action: 'DescribeSplitItemBill' as const, productCode })),
    ];
    for (const { action, productCode } of plans) {
      const evidence: BillingQueryEvidence = { requestIds: [], pageCount: 0, rowCount: 0, complete: false };
      try {
        const rows = await this.bss.captureQuery(evidence, () => this.bss.listMonthlyDiagnosticItems(cycle, action, context, productCode));
        const products = new Map<string, number>();
        for (const row of rows) {
          const key = JSON.stringify(Object.fromEntries(productFields.filter(field => Object.hasOwn(row, field)).map(field => [field, safe(row[field])])));
          products.set(key, (products.get(key) ?? 0) + 1);
        }
        queries.push({ action, ...(productCode ? { productCode } : {}), ...evidence, inventoryScope: 'account_product_counts_only',
          productInventory: [...products].map(([key, rowCount]) => ({ ...JSON.parse(key), rowCount })),
          resources: selected.map(ledger => {
            const related = rows.filter(row => row.InstanceID === ledger.cloudResourceId || row.SplitItemID === ledger.cloudResourceId
              || row.ProductCode === 'cdt' && cdtBillingIdentity(String(row.InstanceID ?? ''))?.resourceId === ledger.cloudResourceId
                && (!cdtBillingIdentity(String(row.InstanceID))?.regionId || cdtBillingIdentity(String(row.InstanceID))?.regionId === ledger.regionId));
            const reference = new RegExp('(?:^|[^A-Za-z0-9_-])' + ledger.cloudResourceId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:$|[^A-Za-z0-9_-])');
            return { ledgerId: ledger.id, cloudResourceId: ledger.cloudResourceId, rowCount: related.length,
              referenceMatchFields: ['InstanceID', 'SplitItemID', 'ResourceId', 'ItemName', 'NickName', 'InstanceName', 'InstanceConfig', 'Tag']
                .filter(field => rows.some(row => typeof row[field] === 'string' && reference.test(row[field]))),
              rows: related.map(row => Object.fromEntries(rowFields.filter(field => Object.hasOwn(row, field)).map(field => [field, safe(row[field])]))),
            };
          }) });
      } catch (error) {
        const errorCode = error instanceof BillingRpcError || error instanceof BillingSplitBillUnavailableError ? error.code : 'BILLING_DIAGNOSTIC_INCOMPLETE';
        queries.push({ action, ...(productCode ? { productCode } : {}), ...evidence, complete: false, errorCode });
      }
    }
    const nativeIds = [...new Set(selected.filter(row => ['ecs', 'disk', 'eip', 'nat_gateway'].includes(row.cloudResourceType)
      && /^(i|d|eip|ngw)-[a-z0-9]+$/.test(row.cloudResourceId)).map(row => row.cloudResourceId))];
    const lifecycleEvidence: BillingQueryEvidence = { requestIds: [], pageCount: 0, rowCount: 0, complete: false };
    let instanceLifecycle: Record<string, unknown>;
    try {
      const rows = await this.bss.captureQuery(lifecycleEvidence, () => nativeIds.length ? this.bss.listInstanceLifecycle(nativeIds, context) : Promise.resolve([]));
      const fields = ['InstanceID', 'ProductCode', 'ProductType', 'Region', 'SubscriptionType', 'Status', 'SubStatus',
        'CreateTime', 'EndTime', 'StopTime', 'ReleaseTime', 'ExpectedReleaseTime'];
      instanceLifecycle = { action: 'QueryAvailableInstances', ...lifecycleEvidence, queriedResourceCount: nativeIds.length,
        coverage: 'official_billing_instance_records', automaticLedgerChanges: false,
        resources: nativeIds.map(id => {
          const record = rows.find(row => row.InstanceID === id);
          return { cloudResourceId: id, returned: Boolean(record),
            ...(record ? { record: Object.fromEntries(fields.filter(field => Object.hasOwn(record, field)).map(field => [field, safe(record[field])])) } : {}) };
        }) };
    } catch (error) {
      instanceLifecycle = { action: 'QueryAvailableInstances', ...lifecycleEvidence, complete: false, queriedResourceCount: nativeIds.length,
        automaticLedgerChanges: false, errorCode: error instanceof BillingRpcError ? error.code : 'INSTANCE_LIFECYCLE_UNVERIFIED' };
    }
    let accountNetworkOverview: Record<string, unknown> | undefined, networkBillingDimensions: Record<string, unknown> | undefined;
    if (selected.some(row => row.cloudResourceType === 'eip')) {
      const fields = ['ProductCode', 'ProductType', 'PipCode', 'CommodityCode', 'ProductName', 'ProductDetail', 'Currency', 'Item', 'SubscriptionType'];
      const amountKind = (value: unknown) => {
        if (value == null || value === '') return 'missing';
        const amount = new BillingDecimal(String(value));
        if (!amount.isFinite()) throw new Error('Network diagnostic amount is unverified');
        return amount.isZero() ? 'zero' : 'nonzero';
      };
      const amountKinds = (row: Record<string, unknown>) => Object.fromEntries(['PretaxGrossAmount', 'PretaxAmount', 'InvoiceDiscount',
        'DeductedByCoupons', 'DeductedByCashCoupons', 'RoundDownDiscount'].map(field => [field, amountKind(row[field])]));
      const evidence: BillingQueryEvidence = { requestIds: [], pageCount: 0, rowCount: 0, complete: false };
      try {
        const rows = await this.bss.captureQuery(evidence, () => this.bss.listMonthlyOverview(cycle, context));
        accountNetworkOverview = { action: 'QueryBillOverview', ...evidence, coverage: 'account_network_products_only', platformAttribution: false,
          productInventory: rows.filter(row => /eip|cdt|cbwp|ipv4|ip.?pool|公网|地址池|共享带宽/i.test(fields.map(field => String(row[field] ?? '')).join(' ')))
            .map(row => ({ ...Object.fromEntries(fields.filter(field => Object.hasOwn(row, field)).map(field => [field, safe(row[field])])),
              amountKinds: amountKinds(row) })) };
      } catch (error) {
        accountNetworkOverview = { action: 'QueryBillOverview', ...evidence, complete: false, platformAttribution: false,
          errorCode: error instanceof BillingRpcError ? error.code : 'MONTHLY_OVERVIEW_UNVERIFIED' };
      }
      const dimensionQueries = [];
      for (const productCode of ['eip', 'cdt', 'cbwp'] as const) for (const action of ['DescribeInstanceBill', 'QueryBill', 'QuerySettleBill', 'QueryAccountBill'] as const) {
        const evidence: BillingQueryEvidence = { requestIds: [], pageCount: 0, rowCount: 0, complete: false };
        const query = { action, productCode, ...(action === 'DescribeInstanceBill' ? { isBillingItem: false } : {}) };
        try {
          const rows = await this.bss.captureQuery(evidence, () => action === 'DescribeInstanceBill' ? this.bss.listMonthlyDiagnosticItems(cycle, action, context, productCode, false)
            : this.bss.listMonthlyNetworkBills(cycle, productCode, context, action));
          const inventory = new Map<string, number>();
          for (const row of rows) {
            const key = JSON.stringify({ ...Object.fromEntries([...fields, 'Status'].filter(field => Object.hasOwn(row, field)).map(field => [field, safe(row[field])])),
              amountKinds: amountKinds(row) });
            inventory.set(key, (inventory.get(key) ?? 0) + 1);
          }
          dimensionQueries.push({ ...query, ...evidence, productInventory: [...inventory].map(([key, rowCount]) => ({ ...JSON.parse(key), rowCount })) });
        } catch (error) {
          dimensionQueries.push({ ...query, ...evidence, complete: false, errorCode: error instanceof BillingRpcError ? error.code : 'NETWORK_BILLING_DIMENSION_UNVERIFIED' });
        }
      }
      networkBillingDimensions = { coverage: 'account_network_products_only', platformAttribution: false,
        complete: dimensionQueries.every(query => query.complete), queries: dimensionQueries };
    }
    const configurationTimelines = await readAliyunResourceConfigTimelines(context, selected);
    return { billingCycle: cycle, cloudWorkspaceId: scope.cloudWorkspaceId, cloudAccountUid: scope.accountUid, checkedAt: new Date(),
      coverage: 'official_monthly_diagnostic_only', billingWrites: 0, complete: queries.every(query => query.complete), resources, queries, instanceLifecycle,
      ...(accountNetworkOverview ? { accountNetworkOverview, networkBillingDimensions } : {}), configurationTimelines };
  }
}
