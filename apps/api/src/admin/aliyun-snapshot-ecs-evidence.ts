import { createHash, randomUUID } from 'node:crypto';
import type { BillingLedgerResourceRecord, PackedImageArtifactRecord } from './admin.repository';
import type { PlatformBillingProof } from './billing-platform-scope';
import { billRegionConflict, billRegionId } from './billing-platform-scope';
import { signAliyunRpcQuery } from './image-catalog-rpc-signer';
import { billingDayText } from './billing-window';

// ActionTrail only retains 90 days of management events. Current DescribeSnapshots cannot prove
// the set of historical (already deleted) snapshots. Never replace that gap with an estimate.
export const ALIYUN_PACK_SNAPSHOT_BASELINE_KIND = 'native_alibaba_pack_snapshot_baseline_v1';
const REGION = /^(cn|ap|eu|us|na|me|af|sa)-[a-z0-9-]+$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;
const EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const instant = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) && Number.isFinite(Date.parse(value));
const names = (values: unknown, prefix?: string): values is string[] => Array.isArray(values) && values.every(id => typeof id === 'string' && (prefix ? new RegExp(`^${prefix}-[a-z0-9]+$`, 'i').test(id) : ID.test(id))) && new Set(values).size === values.length;
const sorted = (values: string[]) => [...values].sort();
const sameIds = (left: string[], right: string[]) => JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
const namespace = (value: { cloudWorkspaceId?: string }) => value.cloudWorkspaceId ?? 'legacy-unbound';
const isoSecond = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');
const DAY = 86_400_000;
const AUDIT_DELAY = 15 * 60_000;

type Credentials = { provider?: string; accountUid: string | null; accessKeyId: string; accessKeySecret: string; cloudAccountContextId?: string | null };
type PackSource = Pick<PackedImageArtifactRecord, 'id' | 'cloudProvider' | 'cloudWorkspaceId' | 'cloudAccountContextId' | 'cloudAccountUid' | 'regionId' | 'ownerUserId' | 'sourceRangeInstanceId' | 'sourceHostKey' | 'sourceInstanceId' | 'sourceDiskIds'>;
const identityKeys = ['id', 'cloudAccountContextId', 'cloudAccountUid', 'regionId', 'ownerUserId', 'sourceRangeInstanceId', 'sourceHostKey', 'sourceInstanceId'] as const;

export type AliyunPackSnapshotBaseline = Record<string, unknown> & {
  kind: typeof ALIYUN_PACK_SNAPSHOT_BASELINE_KIND;
  sourceDiskIds: string[];
  sourceDisks: Array<{ sourceDiskId: string; snapshotIds: string[]; requestIds: string[] }>;
  autoSnapshotPolicyIds: string[];
  policyRequestIds: string[];
  observedAt: string;
};

export function readAliyunPackSnapshotBaseline(source: PackSource & Pick<PackedImageArtifactRecord, 'sourceSnapshotBaseline'>): AliyunPackSnapshotBaseline | null {
  const input = source.sourceSnapshotBaseline;
  if (!object(input) || (source.cloudProvider ?? 'alibaba_cloud') !== 'alibaba_cloud' || input.cloudProvider !== 'alibaba_cloud'
    || input.kind !== ALIYUN_PACK_SNAPSHOT_BASELINE_KIND || identityKeys.some(key => input[key] !== source[key])
    || input.cloudWorkspaceId !== namespace(source) || !instant(input.observedAt) || !names(input.sourceDiskIds, 'd') || !input.sourceDiskIds.length
    || !sameIds(input.sourceDiskIds, source.sourceDiskIds) || !names(input.autoSnapshotPolicyIds, 'sp')
    || !names(input.policyRequestIds) || !input.policyRequestIds.length || !Array.isArray(input.sourceDisks) || input.sourceDisks.length !== source.sourceDiskIds.length) return null;
  const disks = new Set<string>();
  for (const row of input.sourceDisks) {
    if (!object(row) || typeof row.sourceDiskId !== 'string' || !source.sourceDiskIds.includes(row.sourceDiskId) || disks.has(row.sourceDiskId)
      || !names(row.snapshotIds, 's') || !names(row.requestIds) || !row.requestIds.length) return null;
    disks.add(row.sourceDiskId);
  }
  return input as AliyunPackSnapshotBaseline;
}

type Dependencies = { fetch?: typeof fetch; pause?: () => Promise<void>; now?: () => Date };
async function rpc(credentials: Credentials, regionId: string, service: 'ecs' | 'actiontrail', action: string, parameters: Record<string, string>, dependencies: Dependencies) {
  if (credentials.provider !== 'alibaba_cloud' || !credentials.accountUid || !REGION.test(regionId)) throw new Error('INVALID_SNAPSHOT_EVIDENCE_CONTEXT');
  const query = signAliyunRpcQuery({ Action: action, AccessKeyId: credentials.accessKeyId, Format: 'JSON', RegionId: regionId,
    SignatureMethod: 'HMAC-SHA1', SignatureNonce: randomUUID(), SignatureVersion: '1.0', Timestamp: isoSecond((dependencies.now ?? (() => new Date()))()),
    Version: service === 'ecs' ? '2014-05-26' : '2020-07-06', ...parameters }, credentials.accessKeySecret);
  const response = await (dependencies.fetch ?? fetch)(`https://${service}.${regionId}.aliyuncs.com/?${query}`, { method: 'GET', signal: AbortSignal.timeout(30_000) });
  const body: unknown = await response.json();
  if (!response.ok || !object(body) || body.Code != null && body.Code !== 'Success' || !ID.test(text(body.RequestId))
    || [credentials.accessKeyId, credentials.accessKeySecret].some(secret => secret && text(body.RequestId).includes(secret))) throw new Error('SNAPSHOT_EVIDENCE_UNAVAILABLE');
  return body;
}

async function pagedEcsInventory(credentials: Credentials, regionId: string, action: string, container: string, item: string, parameters: Record<string, string>, dependencies: Dependencies) {
  const rows: Record<string, unknown>[] = [], requestIds: string[] = [];
  let expected: number | null = null;
  for (let page = 1; page <= 200; page++) {
    const body = await rpc(credentials, regionId, 'ecs', action, { ...parameters, PageNumber: String(page), PageSize: '100' }, dependencies);
    if (!Number.isSafeInteger(body.TotalCount) || (body.TotalCount as number) < 0 || expected !== null && body.TotalCount !== expected
      || body.PageNumber != null && Number(body.PageNumber) !== page || body.PageSize != null && Number(body.PageSize) !== 100) throw new Error('INCOMPLETE_SNAPSHOT_INVENTORY');
    expected = body.TotalCount as number;
    const nested = object(body[container]) ? body[container] : null;
    const values = nested?.[item] ?? (expected === 0 ? [] : null);
    if (!Array.isArray(values) || values.some(value => !object(value)) || values.length > 100 || !values.length && rows.length < expected) throw new Error('INCOMPLETE_SNAPSHOT_INVENTORY');
    rows.push(...values as Record<string, unknown>[]); requestIds.push(text(body.RequestId));
    if (rows.length > expected) throw new Error('INCOMPLETE_SNAPSHOT_INVENTORY');
    if (rows.length === expected) return { rows, requestIds };
  }
  throw new Error('INCOMPLETE_SNAPSHOT_INVENTORY');
}

// Capture at pack submission time, not retroactively after billing. A policy may be associated
// through pre-existing instance tags; an empty *current* snapshot list alone cannot exclude it.
export async function collectAliyunPackSnapshotBaseline(credentials: Credentials, source: PackSource, dependencies: Dependencies = {}): Promise<AliyunPackSnapshotBaseline | null> {
  try {
    if (credentials.accountUid !== source.cloudAccountUid || credentials.cloudAccountContextId !== source.cloudAccountContextId
      || (source.cloudProvider ?? 'alibaba_cloud') !== 'alibaba_cloud' || !names(source.sourceDiskIds, 'd') || !source.sourceDiskIds.length) return null;
    const policy = await pagedEcsInventory(credentials, source.regionId, 'DescribeAutoSnapshotPolicyEx', 'AutoSnapshotPolicies', 'AutoSnapshotPolicy', {}, dependencies);
    const autoSnapshotPolicyIds = policy.rows.map(row => text(row.AutoSnapshotPolicyId));
    if (!names(autoSnapshotPolicyIds, 'sp')) return null;
    const sourceDisks: AliyunPackSnapshotBaseline['sourceDisks'] = [];
    for (const sourceDiskId of source.sourceDiskIds) {
      const inventory = await pagedEcsInventory(credentials, source.regionId, 'DescribeSnapshots', 'Snapshots', 'Snapshot', { DiskId: sourceDiskId }, dependencies);
      const snapshotIds = inventory.rows.map(row => text(row.SnapshotId));
      if (!names(snapshotIds, 's') || inventory.rows.some(row => row.SourceDiskId !== sourceDiskId)) return null;
      sourceDisks.push({ sourceDiskId, snapshotIds, requestIds: inventory.requestIds });
    }
    const baseline = { ...source, cloudProvider: 'alibaba_cloud', cloudWorkspaceId: namespace(source), kind: ALIYUN_PACK_SNAPSHOT_BASELINE_KIND,
      sourceDiskIds: [...source.sourceDiskIds], sourceDisks, autoSnapshotPolicyIds, policyRequestIds: policy.requestIds,
      observedAt: (dependencies.now ?? (() => new Date()))().toISOString() };
    return readAliyunPackSnapshotBaseline({ ...source, sourceSnapshotBaseline: baseline });
  } catch { return null; }
}

export type AliyunSnapshotEvent = {
  id: string; time: string; name: string; type: string; failed: boolean;
  requestResourceIds: string[]; responseResourceIds: string[]; resourceIds: string[];
};
export type AliyunSnapshotHistory = {
  version: 1; provider: 'alibaba_cloud'; cloudWorkspaceId: string; cloudAccountUid: string; regionId: string;
  sourceInstanceId: string; startAt: string; endAt: string; observedAt: string; requestIds: string[]; events: AliyunSnapshotEvent[];
};
const resourceId = /^(?:i|d|s|m|sp)-[a-z0-9]+$/i;
function resourceIds(value: unknown, depth = 0): string[] {
  if (depth > 8) throw new Error('INVALID_SNAPSHOT_EVENT');
  if (typeof value === 'string') return resourceId.test(value) ? [value] : [];
  if (Array.isArray(value)) return [...new Set(value.flatMap(item => resourceIds(item, depth + 1)))];
  if (object(value)) return [...new Set(Object.values(value).flatMap(item => resourceIds(item, depth + 1)))];
  return [];
}
function normalizeEvent(raw: unknown, accountUid: string, regionId: string, startAt: string, endAt: string): AliyunSnapshotEvent {
  if (!object(raw) || !EVENT_ID.test(text(raw.eventId)) || !instant(raw.eventTime) || Date.parse(raw.eventTime) < Date.parse(startAt) || Date.parse(raw.eventTime) > Date.parse(endAt)
    || raw.acsRegion !== regionId || raw.serviceName !== 'Ecs' || !['ApiCall', 'ConsoleOperation', 'AliyunServiceEvent'].includes(text(raw.eventType))
    || !/^[A-Za-z][A-Za-z0-9.:]+$/.test(text(raw.eventName)) || raw.eventCategory != null && raw.eventCategory !== 'Management') throw new Error('INVALID_SNAPSHOT_EVENT');
  // Cross-account callers are not resource ownership proof. Management events may expose the
  // owner through recipientAccountId or through the caller identity for same-account calls.
  const owner = text(raw.recipientAccountId) || (object(raw.userIdentity) ? text(raw.userIdentity.accountId) : '');
  if (owner !== accountUid && !(owner === '' && object(raw.userIdentity) && raw.userIdentity.type === 'system')) throw new Error('UNVERIFIED_SNAPSHOT_EVENT_ACCOUNT');
  let parameters = raw.requestParameters;
  if (parameters == null && typeof raw.requestParameterJson === 'string') {
    try { parameters = JSON.parse(raw.requestParameterJson); } catch { throw new Error('INVALID_SNAPSHOT_EVENT'); }
  }
  return { id: text(raw.eventId), time: raw.eventTime, name: text(raw.eventName), type: text(raw.eventType), failed: Boolean(text(raw.errorCode)),
    requestResourceIds: sorted(resourceIds(parameters)), responseResourceIds: sorted(resourceIds(raw.responseElements)),
    resourceIds: sorted(resourceIds(raw.referencedResources)) };
}

type SnapshotScopedProof = PlatformBillingProof & { snapshotParentProof?: PlatformBillingProof };
function snapshotParentProof(proof: PlatformBillingProof) {
  return (proof as SnapshotScopedProof).snapshotParentProof ?? proof;
}

export function aliyunSnapshotHistoryStartAt(source: BillingLedgerResourceRecord, proof: PlatformBillingProof) {
  const job = snapshotParentProof(proof).creationJobs?.get(source.id);
  const dates = [source.billingStartAt, job?.startedAt ?? job?.createdAt].filter((value): value is Date => value instanceof Date && Number.isFinite(value.getTime()));
  return dates.length ? new Date(Math.floor(Math.min(...dates.map(date => date.getTime())) / 1000) * 1000 - 1000) : null;
}
const billingEnd = (billingDate: string) => /^\d{4}-\d{2}-\d{2}$/.test(billingDate) && Number.isFinite(Date.parse(billingDate))
  && new Date(billingDate).toISOString().slice(0, 10) === billingDate ? new Date(Date.parse(`${billingDate}T16:00:00.000Z`) - 1000) : null;

// LookupEvents 2020-07-06: query the whole regional ECS management history, not ResourceName.
// A ResourceName filter can omit CreateImage, policy changes and deleted source disks/snapshots.
// https://help.aliyun.com/zh/actiontrail/developer-reference/api-actiontrail-2020-07-06-lookupevents
export async function collectAliyunSnapshotHistory(credentials: Credentials, input: { sourceLedger: BillingLedgerResourceRecord; sourceCreatedAt: Date; billingDate: string }, dependencies: Dependencies = {}): Promise<AliyunSnapshotHistory | null> {
  try {
    const source = input.sourceLedger, now = (dependencies.now ?? (() => new Date()))(), end = billingEnd(input.billingDate);
    const start = new Date(Math.floor(input.sourceCreatedAt.getTime() / 1000) * 1000);
    if (!end || !Number.isFinite(start.getTime()) || start >= end || start.getTime() < now.getTime() - 90 * DAY || now.getTime() - end.getTime() < AUDIT_DELAY
      || source.cloudProvider !== 'alibaba_cloud' || credentials.accountUid !== source.cloudAccountUid || !/^i-[a-z0-9]+$/i.test(source.cloudResourceId)) return null;
    const requestIds: string[] = [], collected = new Map<string, AliyunSnapshotEvent>();
    const pause = dependencies.pause ?? (() => new Promise(resolve => setTimeout(resolve, 550)));
    for (let windowStart = start.getTime(); windowStart < end.getTime();) {
      const windowEnd = Math.min(windowStart + 29 * DAY, end.getTime());
      const startAt = isoSecond(new Date(windowStart)), endAt = isoSecond(new Date(windowEnd));
      const tokens = new Set<string>(), pageIds = new Set<string>();
      let nextToken: string | null = null, completed = false;
      for (let page = 0; page < 200; page++) {
        if (requestIds.length) await pause();
        const body = await rpc(credentials, source.regionId, 'actiontrail', 'LookupEvents', { StartTime: startAt, EndTime: endAt, MaxResults: '50', Direction: 'FORWARD',
          'LookupAttribute.1.Key': 'ServiceName', 'LookupAttribute.1.Value': 'Ecs', ...(nextToken ? { NextToken: nextToken } : {}) }, dependencies);
        if (body.StartTime !== startAt || body.EndTime !== endAt || !Array.isArray(body.Events) || body.Events.length > 50
          || body.NextToken != null && typeof body.NextToken !== 'string') return null;
        requestIds.push(text(body.RequestId));
        for (const raw of body.Events) {
          const event = normalizeEvent(raw, credentials.accountUid!, source.regionId, startAt, endAt);
          if (pageIds.has(event.id)) return null;
          pageIds.add(event.id);
          const prior = collected.get(event.id);
          // Adjacent windows share one boundary second. Only that exact duplicate is allowed.
          if (prior && (Date.parse(event.time) !== windowStart || JSON.stringify(prior) !== JSON.stringify(event))) return null;
          collected.set(event.id, event);
        }
        nextToken = text(body.NextToken) || null;
        if (!nextToken) { completed = true; break; }
        if (!body.Events.length || tokens.has(nextToken)) return null;
        tokens.add(nextToken);
      }
      if (!completed) return null;
      windowStart = windowEnd;
    }
    const events = [...collected.values()].sort((a, b) => a.time.localeCompare(b.time) || a.id.localeCompare(b.id));
    return { version: 1, provider: 'alibaba_cloud', cloudWorkspaceId: namespace(source), cloudAccountUid: credentials.accountUid!, regionId: source.regionId,
      sourceInstanceId: source.cloudResourceId, startAt: isoSecond(start), endAt: isoSecond(end), observedAt: now.toISOString(), requestIds, events };
  } catch { return null; }
}

export type AliyunSnapshotEcsScope = {
  version: 1; kind: 'snapshot_ecs'; cloudWorkspaceId: string; cloudAccountUid: string; regionId: string;
  sourceInstanceId: string; sourceLedgerId: string; snapshotLedgerIds: string[]; snapshotIds: string[]; artifactIds: string[];
  history: { startAt: string; endAt: string; observedAt: string; requestIds: string[]; eventIds: string[]; digest: string };
};

type VerificationInput = { line: Record<string, unknown>; billingDate: string; cloudAccountUid: string; proof: PlatformBillingProof; history: AliyunSnapshotHistory | null };
function sourceForBill({ line, cloudAccountUid, proof }: Omit<VerificationInput, 'history' | 'billingDate'>) {
  const region = billRegionId(line);
  if (line.__platformBillingSource !== 'DescribeSplitItemBill' || line.__platformCloudProvider != null && line.__platformCloudProvider !== 'alibaba_cloud'
    || line.ProductCode !== 'snapshot' || !/^i-[a-z0-9]+$/i.test(text(line.SplitItemID)) || !region || billRegionConflict(line)
    || ['OwnerID', 'SplitAccountID', 'BillAccountID'].some(key => line[key] != null && line[key] !== '' && line[key] !== cloudAccountUid)) return null;
  const parent = snapshotParentProof(proof);
  const sources = parent.ledgers.filter(ledger => parent.createdLedgerIds.has(ledger.id) && ledger.cloudProvider === 'alibaba_cloud'
    && ledger.cloudAccountUid === cloudAccountUid && ledger.regionId === region && ledger.cloudResourceType === 'ecs' && ledger.cloudResourceId === text(line.SplitItemID));
  return sources.length === 1 ? sources[0] : null;
}
function sourceArtifacts(source: BillingLedgerResourceRecord, proof: PlatformBillingProof, billingDate: string) {
  return snapshotParentProof(proof).packedImages.filter(artifact => (artifact.cloudProvider ?? 'alibaba_cloud') === 'alibaba_cloud' && namespace(artifact) === namespace(source)
    && artifact.cloudAccountUid === source.cloudAccountUid && artifact.regionId === source.regionId && artifact.sourceInstanceId === source.cloudResourceId
    && artifact.sourceRangeInstanceId === source.rangeInstanceId && artifact.ownerUserId === source.ownerUserId && billingDayText(artifact.createdAt) <= billingDate);
}
function snapshotLedgers(source: BillingLedgerResourceRecord, proof: PlatformBillingProof, artifacts: PackedImageArtifactRecord[]) {
  const ids = artifacts.flatMap(artifact => artifact.backingSnapshotIds);
  if (!ids.length || !names(ids, 's')) return null;
  const parent = snapshotParentProof(proof);
  const rows = ids.map(id => parent.ledgers.filter(ledger => parent.createdLedgerIds.has(ledger.id) && ledger.cloudProvider === 'alibaba_cloud' && ledger.cloudResourceType === 'snapshot'
    && namespace(ledger) === namespace(source) && ledger.cloudAccountUid === source.cloudAccountUid && ledger.regionId === source.regionId && ledger.cloudResourceId === id
    && ledger.ownerUserId === source.ownerUserId && ledger.billingScope === source.billingScope && ledger.rangeInstanceId === source.rangeInstanceId));
  if (rows.some(row => row.length !== 1)) return null;
  return rows.map(row => row[0]);
}

function baselineMatchesHistoricalSnapshots(baseline: AliyunPackSnapshotBaseline, snapshots: BillingLedgerResourceRecord[]) {
  const observedAt = Date.parse(baseline.observedAt);
  const expected = snapshots.filter(snapshot => snapshot.billingStartAt.getTime() <= observedAt
    && (!snapshot.releasedAt || snapshot.releasedAt.getTime() >= observedAt)).map(snapshot => snapshot.cloudResourceId);
  const observed = [...new Set(baseline.sourceDisks.flatMap(disk => disk.snapshotIds))];
  return sameIds(expected, observed);
}

// A pre-cutoff platform ECS can prove the source of a new snapshot. Its full historical
// snapshot set remains evidence, while every snapshot chargeable on this bill day must belong
// to the current creation scope. A mixed old/new source-host total cannot be split safely.
function snapshotsInCurrentBillingScope(snapshots: BillingLedgerResourceRecord[], proof: PlatformBillingProof, billingDate: string) {
  const chargeable = snapshots.filter(snapshot => billingDayText(snapshot.billingStartAt) <= billingDate
    && (!snapshot.releasedAt || billingDayText(snapshot.releasedAt) >= billingDate));
  return chargeable.length > 0 && chargeable.every(snapshot => proof.createdLedgerIds.has(snapshot.id)
    && proof.ledgers.some(current => current.id === snapshot.id && current.cloudResourceType === 'snapshot'
      && current.cloudResourceId === snapshot.cloudResourceId && namespace(current) === namespace(snapshot)
      && current.cloudAccountUid === snapshot.cloudAccountUid && current.regionId === snapshot.regionId));
}

export function verifyAliyunSnapshotEcsBillEvidence(input: VerificationInput): AliyunSnapshotEcsScope | null {
  const { proof, history, billingDate } = input, source = sourceForBill(input), end = billingEnd(billingDate), parent = snapshotParentProof(proof);
  if (!source || !history || !end || !instant(history.startAt) || !instant(history.endAt) || !instant(history.observedAt) || history.version !== 1 || history.provider !== 'alibaba_cloud'
    || history.cloudWorkspaceId !== namespace(source) || history.cloudAccountUid !== source.cloudAccountUid || history.regionId !== source.regionId || history.sourceInstanceId !== source.cloudResourceId
    || !names(history.requestIds) || !history.requestIds.length || Date.parse(history.endAt) !== end.getTime() || Date.parse(history.observedAt) - end.getTime() < AUDIT_DELAY
    || !Array.isArray(history.events) || !history.events.length || new Set(history.events.map(event => event.id)).size !== history.events.length) return null;
  const expectedStart = aliyunSnapshotHistoryStartAt(source, proof);
  if (!expectedStart || Date.parse(history.startAt) > expectedStart.getTime()) return null;
  const artifacts = sourceArtifacts(source, proof, billingDate), snapshots = snapshotLedgers(source, proof, artifacts);
  if (!artifacts.length || !snapshots || artifacts.some(artifact => !artifact.imageId || !names(artifact.sourceDiskIds, 'd') || !artifact.sourceDiskIds.length
    || !names(artifact.backingSnapshotIds, 's') || artifact.backingSnapshotIds.length !== artifact.sourceDiskIds.length)) return null;
  const diskIds = new Set(artifacts.flatMap(artifact => artifact.sourceDiskIds));
  for (const diskId of diskIds) {
    const disks = parent.ledgers.filter(ledger => parent.createdLedgerIds.has(ledger.id) && ledger.cloudProvider === 'alibaba_cloud' && ledger.cloudResourceType === 'disk'
      && ledger.cloudResourceId === diskId && namespace(ledger) === namespace(source) && ledger.cloudAccountUid === source.cloudAccountUid && ledger.regionId === source.regionId
      && ledger.ownerUserId === source.ownerUserId && ledger.rangeInstanceId === source.rangeInstanceId && ledger.sourceProvisionJobId === source.sourceProvisionJobId);
    if (disks.length !== 1) return null;
  }
  // A historical empty baseline is useful only when the whole preceding source lifetime is
  // covered by mature audit events. Never create one retroactively for an old billing day.
  const baselines = artifacts.map(readAliyunPackSnapshotBaseline).filter((baseline): baseline is AliyunPackSnapshotBaseline => Boolean(baseline));
  const baseline = baselines.filter(item => Date.parse(item.observedAt) <= end.getTime() - AUDIT_DELAY && !item.autoSnapshotPolicyIds.length)
    .sort((a, b) => a.observedAt.localeCompare(b.observedAt))[0];
  if (!baseline || !baselineMatchesHistoricalSnapshots(baseline, snapshots)) return null;
  const imageArtifacts = new Map(artifacts.map(artifact => [artifact.imageId!, artifact]));
  const knownSnapshots = new Set(snapshots.map(snapshot => snapshot.cloudResourceId));
  const recordedImages = new Set<string>(), recordedSnapshots = new Set<string>();
  let sourceBorn = false;
  for (const event of history.events) {
    if (!EVENT_ID.test(event.id) || !instant(event.time) || Date.parse(event.time) < Date.parse(history.startAt) || Date.parse(event.time) > end.getTime()
      || !names(event.requestResourceIds) || !names(event.responseResourceIds) || !names(event.resourceIds) || typeof event.failed !== 'boolean'
      || !['ApiCall', 'ConsoleOperation', 'AliyunServiceEvent'].includes(event.type) || !event.name) return null;
    const references = [...event.requestResourceIds, ...event.responseResourceIds, ...event.resourceIds];
    const touchesSource = references.some(id => id === source.cloudResourceId || diskIds.has(id) || knownSnapshots.has(id) || imageArtifacts.has(id));
    if (/AutoSnapshot|SnapshotPolicy/i.test(event.name)) return null; // Includes pre-existing tag policies changed or removed during the lifetime.
    if (['RunInstances', 'CreateInstance'].includes(event.name) && event.responseResourceIds.includes(source.cloudResourceId)) {
      if (event.failed || sourceBorn || event.requestResourceIds.some(id => /^d-/.test(id)) || Date.parse(event.time) > source.createdAt.getTime()) return null;
      sourceBorn = true; continue;
    }
    if (event.name === 'CreateImage') {
      if (!event.requestResourceIds.some(id => /^i-/.test(id))) return null;
      if (!event.requestResourceIds.includes(source.cloudResourceId)) { if (touchesSource) return null; continue; }
      const ids = event.responseResourceIds.filter(id => /^m-/.test(id));
      const artifact = ids.length === 1 ? imageArtifacts.get(ids[0]) : null;
      if (event.failed || !artifact || recordedImages.has(ids[0]) || event.requestResourceIds.some(id => /^s-/.test(id))
        || Date.parse(event.time) < artifact.createdAt.getTime() - 1000) return null;
      recordedImages.add(ids[0]); artifact.backingSnapshotIds.forEach(id => recordedSnapshots.add(id)); continue;
    }
    if (event.name === 'CreateSnapshot') {
      const disks = event.requestResourceIds.filter(id => /^d-/.test(id));
      if (!disks.length) return null;
      if (!disks.some(id => diskIds.has(id))) { if (touchesSource) return null; continue; }
      const ids = event.responseResourceIds.filter(id => /^s-/.test(id));
      if (event.failed || disks.length !== 1 || ids.length !== 1 || !knownSnapshots.has(ids[0])) return null;
      recordedSnapshots.add(ids[0]); continue;
    }
    // Disk moves/replacement can cause another business's snapshots to be charged to the source
    // ECS. Unknown snapshot/image mutations are unsafe even after all visible snapshots vanish.
    if (touchesSource && /(?:AttachDisk|DetachDisk|Replace|ReInit|ResetDisk|Import|Copy|CreateSnapshotGroup)/i.test(event.name)) return null;
    if (!/^Describe|^List|^Get/.test(event.name) && /Snapshot|Image/i.test(event.name)
      && !['DeleteSnapshot', 'DeleteImage', 'ModifySnapshotAttribute', 'ModifyImageAttribute'].includes(event.name)) return null;
    if (touchesSource && event.failed && /Snapshot|Image|Disk/.test(event.name)) return null;
  }
  if (!sourceBorn || artifacts.some(artifact => !recordedImages.has(artifact.imageId!)) || snapshots.some(snapshot => !recordedSnapshots.has(snapshot.cloudResourceId))
    || !snapshotsInCurrentBillingScope(snapshots, proof, billingDate)) return null;
  return { version: 1, kind: 'snapshot_ecs', cloudWorkspaceId: namespace(source), cloudAccountUid: input.cloudAccountUid, regionId: source.regionId,
    sourceInstanceId: source.cloudResourceId, sourceLedgerId: source.id, snapshotLedgerIds: sorted(snapshots.map(snapshot => snapshot.id)),
    snapshotIds: sorted([...knownSnapshots]), artifactIds: sorted(artifacts.map(artifact => artifact.id)), history: { startAt: history.startAt, endAt: history.endAt,
      observedAt: history.observedAt, requestIds: history.requestIds, eventIds: history.events.map(event => event.id),
      digest: createHash('sha256').update(JSON.stringify(history.events)).digest('hex') } };
}

// Persisted evidence was produced server-side from the official complete history. Revalidate the
// account, workspace and current immutable source chain on reads; a resource owner alone is not proof.
export function readAliyunSnapshotEcsScope(line: Record<string, unknown>, proof: PlatformBillingProof, billingDate: string, cloudAccountUid: string): AliyunSnapshotEcsScope | null {
  const value = line.__platformSnapshotEcsScope, source = sourceForBill({ line, proof, cloudAccountUid });
  if (!object(value) || !source || value.version !== 1 || value.kind !== 'snapshot_ecs' || value.cloudWorkspaceId !== namespace(source)
    || value.cloudAccountUid !== cloudAccountUid || value.regionId !== source.regionId || value.sourceInstanceId !== source.cloudResourceId || value.sourceLedgerId !== source.id
    || !names(value.snapshotLedgerIds) || !names(value.snapshotIds, 's') || !names(value.artifactIds) || !object(value.history)
    || !instant(value.history.startAt) || !instant(value.history.endAt) || !instant(value.history.observedAt) || !names(value.history.requestIds)
    || !value.history.requestIds.length || !Array.isArray(value.history.eventIds) || !value.history.eventIds.length
    || value.history.eventIds.some(id => typeof id !== 'string' || !EVENT_ID.test(id)) || new Set(value.history.eventIds).size !== value.history.eventIds.length || !/^[a-f0-9]{64}$/.test(text(value.history.digest))) return null;
  const end = billingEnd(billingDate), start = aliyunSnapshotHistoryStartAt(source, proof);
  if (!end || !start || Date.parse(value.history.endAt) !== end.getTime() || Date.parse(value.history.startAt) > start.getTime()
    || Date.parse(value.history.observedAt) - end.getTime() < AUDIT_DELAY) return null;
  const artifacts = sourceArtifacts(source, proof, billingDate), snapshots = snapshotLedgers(source, proof, artifacts);
  if (!snapshots || !snapshotsInCurrentBillingScope(snapshots, proof, billingDate) || !sameIds(value.snapshotLedgerIds, snapshots.map(snapshot => snapshot.id)) || !sameIds(value.snapshotIds, snapshots.map(snapshot => snapshot.cloudResourceId))
    || !sameIds(value.artifactIds, artifacts.map(artifact => artifact.id)) || !artifacts.some(artifact => {
      const baseline = readAliyunPackSnapshotBaseline(artifact);
      return baseline && !baseline.autoSnapshotPolicyIds.length && Date.parse(baseline.observedAt) <= end.getTime() - AUDIT_DELAY
        && baselineMatchesHistoricalSnapshots(baseline, snapshots);
    })) return null;
  return value as AliyunSnapshotEcsScope;
}
