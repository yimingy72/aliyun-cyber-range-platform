import type { BillingLineItemRecord } from './admin.repository';
import { BillingDecimal } from './billing-amount';
import { billingKey } from './billing-reconciliation-types';

export type BillingDocumentStatus = 'issued' | 'partial' | 'unissued' | 'not_applicable' | 'pending';
type Amount = { currency: string; pretaxAmount: number; pretaxAmountExact?: string };
type Resource = { ledgerId: string; cloudResourceId: string; cloudResourceType: string; state: string; reasonMessage?: string | null; parentBillingResourceId?: string | null };

export function billingDocumentStatus(entry: { amounts: Amount[]; reconciliationStatus: string; coveredByEntryId?: string | null; billingNotRequired?: boolean }): BillingDocumentStatus {
  if (entry.amounts.length || entry.coveredByEntryId) return entry.reconciliationStatus === 'current' ? 'issued' : 'partial';
  if (entry.billingNotRequired) return 'not_applicable';
  if (['source_pending','query_error'].includes(entry.reconciliationStatus)) return 'pending';
  return 'unissued';
}

export function billingNetworkCategory(item: Pick<BillingLineItemRecord, 'productCode' | 'billItem' | 'rawPayload'>) {
  const label = [item.rawPayload.BillingItemCode, item.rawPayload.BillingItem, item.rawPayload.CommodityCode, item.billItem].filter(value => typeof value === 'string').join(' ');
  if (['cdt','cbwp'].includes(item.productCode) || /traffic|flow|bandwidth|internet.*bytes|流量|带宽/i.test(label)) return 'network_usage';
  if (/instance|rent|retain|保有|配置|占用/i.test(label)) return 'eip_configuration';
  return null;
}

export type BillingCharge = {
  id: string; resourceId: string; resourceType: string; name: string; category: string; status: 'issued' | 'unissued' | 'unknown' | 'not_returned';
  amounts: Amount[]; usage: string | null; usageUnit: string | null; billingFrom: string | null; billingTo: string | null;
  transactionType: string | null; message: string | null; rowCount: number;
};
const typeNames: Record<string,string> = { ecs: '云服务器费用', disk: '磁盘费用', eip: '弹性公网 IP 费用', snapshot: '快照存储', image: '镜像费用', nat_gateway: 'NAT 网关费用', oss_bucket: '对象存储费用' };
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';

export type BillingEcsSpec = { cpu?: number; memory?: string; systemDisk?: string; instanceType?: string; os?: string };

// Only project official configuration fields from the booked ECS itself. Usage is cumulative, not disk size.
export function billingEcsSpecs(items: BillingLineItemRecord[]) {
  const specs = new Map<string, BillingEcsSpec | null>();
  for (const item of items) {
    const raw = item.rawPayload;
    if (item.cloudResourceType !== 'ecs' || item.productCode !== 'ecs' || raw.InstanceID !== item.cloudResourceId || specs.get(item.cloudResourceId) === null) continue;
    const next: BillingEcsSpec = {};
    const instanceType = text(raw.InstanceSpec);
    if (/^ecs\.[a-z0-9][a-z0-9._-]{1,80}$/i.test(instanceType)) next.instanceType = instanceType;
    const config = text(raw.InstanceConfig);
    if (config.length <= 8192) for (const part of config.split(/[;；\n]/)) {
      const cpu = /^CPU\s*[:：]\s*([1-9]\d{0,3})\s*(?:核|vCPUs?)?$/i.exec(part.trim());
      const size = /^(内存|系统盘大小)\s*[:：]\s*([1-9]\d{0,5}(?:\.\d{1,3})?)\s*(GiB|GB|MiB|MB)$/i.exec(part.trim());
      const os = /^镜像平台\s*[:：]\s*(Linux|Windows)$/i.exec(part.trim());
      if (cpu) next.cpu = Number(cpu[1]);
      if (size) next[size[1] === '内存' ? 'memory' : 'systemDisk'] = `${size[2]} ${size[3]}`;
      if (os) next.os = os[1].toLowerCase() === 'linux' ? 'Linux' : 'Windows';
    }
    if (!Object.keys(next).length) continue;
    const prior = specs.get(item.cloudResourceId) ?? {};
    const conflicting = (Object.keys(next) as Array<keyof BillingEcsSpec>).some(key => prior[key] !== undefined && prior[key] !== next[key]);
    specs.set(item.cloudResourceId, conflicting ? null : {...prior,...next});
  }
  return specs;
}

export function billingChargeItems(items: BillingLineItemRecord[], resources: Resource[], directPublicHost = false): BillingCharge[] {
  const groups = new Map<string, BillingCharge & { amount: InstanceType<typeof BillingDecimal>; quantity: InstanceType<typeof BillingDecimal>; knownUsage: boolean }>();
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.sourceFingerprint)) continue;
    seen.add(item.sourceFingerprint);
    const raw = item.rawPayload, components = Array.isArray(raw.ComponentSet) ? raw.ComponentSet : [];
    const component = components[Number(raw.__platformBillingComponentIndex)] as Record<string,unknown> | undefined;
    const name = text(raw.BillingItem) || text(component?.ComponentName) || item.billItem || typeNames[item.cloudResourceType] || '资源费用';
    const unit = text(raw.UsageUnit) || text(component?.UsedAmountUnit);
    const usage = raw.Usage ?? component?.UsedAmount;
    const quantity = typeof usage === 'number' && Number.isFinite(usage) ? String(usage) : text(usage);
    const transaction = text(raw.Item) || text(raw.ActionType);
    const key = billingKey([item.matchedLedgerId, item.productCode, item.currency, text(raw.CommodityCode), text(raw.BillingItemCode) || name, transaction, unit]);
    const date = item.billingDate.toISOString().slice(0,10);
    const row = groups.get(key) ?? { id: key, resourceId: item.cloudResourceId, resourceType: item.productCode === 'snapshot' ? 'snapshot' : item.cloudResourceType,
      name, category: billingNetworkCategory(item) === 'network_usage' ? 'network_usage' : item.productCode === 'snapshot' ? 'snapshot' : item.cloudResourceType === 'eip' ? billingNetworkCategory(item) ?? 'eip' : item.cloudResourceType,
      status: 'issued' as const, amounts: [], usage: null, usageUnit: unit || null,
      billingFrom: date, billingTo: date, transactionType: transaction || null, message: null, rowCount: 0,
      amount: new BillingDecimal(0), quantity: new BillingDecimal(0), knownUsage: Boolean(unit) };
    row.amount = row.amount.plus(item.pretaxAmount); row.rowCount++;
    if (unit && /^-?\d+(?:\.\d+)?$/.test(quantity) && quantity.length <= 128) row.quantity = row.quantity.plus(quantity);
    else row.knownUsage = false;
    row.billingFrom = [row.billingFrom!, date].sort()[0]; row.billingTo = [row.billingTo!, date].sort().at(-1)!;
    row.amounts = [{ currency: item.currency, pretaxAmount: row.amount.toNumber(),
      ...(!new BillingDecimal(row.amount.toNumber()).equals(row.amount) ? { pretaxAmountExact: row.amount.toFixed() } : {}) }];
    groups.set(key, row);
  }
  const charges: BillingCharge[] = [...groups.values()].map(({amount,quantity,knownUsage,...row}) => ({...row,usage:knownUsage?quantity.toFixed():null}));
  for (const resource of resources) {
    const existing = charges.filter(row => row.resourceId === resource.cloudResourceId);
    const categories = resource.cloudResourceType === 'eip' ? ['eip_configuration','network_usage'] : existing.length || resource.state === 'covered_by_parent' ? [] : [resource.cloudResourceType];
    for (const category of categories) {
      if (existing.some(row => row.category === category)) continue;
      charges.push({ id: billingKey([resource.ledgerId, category]), resourceId: resource.cloudResourceId, resourceType: resource.cloudResourceType,
        name: category === 'network_usage' ? '公网流量 / 带宽' : category === 'eip_configuration' ? '公网 IP 配置费' : typeNames[category] || '资源费用', category,
        status: ['source_pending','query_error'].includes(resource.state) ? 'unknown' : 'unissued', amounts: [], usage: null, usageUnit: null,
        billingFrom: null, billingTo: null, transactionType: null, message: resource.reasonMessage ?? null, rowCount: 0 });
    }
    if (directPublicHost && resource.cloudResourceType === 'ecs' && !existing.some(row => row.category === 'network_usage'))
      charges.push({ id: billingKey([resource.ledgerId,'network_usage']), resourceId: resource.cloudResourceId, resourceType: 'ecs', name: '公网流量 / 带宽', category: 'network_usage',
        status: 'not_returned', amounts: [], usage: null, usageUnit: null, billingFrom: null, billingTo: null, transactionType: null,
        message: '尚未取得该实例的官方网络费用明细。', rowCount: 0 });
  }
  return charges;
}
