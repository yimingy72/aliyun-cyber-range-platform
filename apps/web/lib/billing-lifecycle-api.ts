import { createAdminHeaders, readJson } from './admin-api';

export type BillingRange = { startAt: string; endAt: string };
export type BillingRequestContext = { apiBaseUrl: string; token: string; workspaceId: string | null; principalKey?: string };
export type BillingDocumentStatus = 'issued' | 'partial' | 'unissued' | 'not_applicable' | 'pending';
export type BillingAmount = { currency: string; pretaxAmount: number; pretaxAmountExact?: string };

export type BillingEntry = {
  id: string;
  kind: 'single' | 'range' | 'platform_image' | 'platform_bucket' | 'resource' | 'platform_import';
  name: string;
  ownerUserId: string | null;
  ownerUsername: string | null;
  batch: { id: string; name: string } | null;
  createdAt: string;
  instanceStatus: string | null;
  plannedExpiresAt: string | null;
  releaseConfirmedAt: string | null;
  lifecycleStatus: 'creating' | 'active' | 'partially_released' | 'released' | 'failed' | 'allocation_ended';
  reconciliationStatus: 'waiting' | 'no_bill' | 'partial' | 'current' | 'query_error' | 'source_pending';
  amounts: BillingAmount[];
  resourceCount: number;
  pendingResourceCount: number;
  lastQueriedAt: string | null;
  lastVerifiedAt: string | null;
  coveredThrough: string | null;
  coveredByEntryId?: string | null;
  issueMessage?: string | null;
  sourceImportJobIds?: string[];
  sourcePackedImageArtifactIds?: string[];
  sourceInstanceId?: string | null;
  sourceInstanceName?: string | null;
  billingStatus?: BillingDocumentStatus;
  billingNotRequired?: boolean;
  rowType?: 'entry' | 'batch';
  members?: BillingEntry[];
};

export type BillingResource = {
  ledgerId: string;
  cloudResourceId: string;
  cloudResourceType: string;
  cloudProvider: string;
  regionId: string;
  billingStartAt: string;
  releasedAt: string | null;
  allocationEndedAt?: string | null;
  state: 'awaiting_query' | 'no_bill' | 'issued' | 'partial' | 'covered_by_parent' | 'query_error' | 'source_pending';
  amounts: BillingAmount[];
  coveredThrough: string | null;
  lastQueriedAt: string | null;
  lastVerifiedAt: string | null;
  reasonCode: string | null;
  reasonMessage: string | null;
  nextQueryAt: string | null;
  parentBillingResourceId: string | null;
  queryTaskId?: string | null;
  lastQueryAttemptId?: string | null;
};

export type BillingEvent = {
  id: string;
  type: string;
  title: string;
  status: string;
  at: string;
  previousExpiresAt?: string | null;
  requestedExpiresAt?: string | null;
  effectiveExpiresAt?: string | null;
};

export type BillingEntriesResult = BillingRange & {
  version: 2;
  mode: 'legacy' | 'shadow' | 'resource';
  items: BillingEntry[];
  page: number;
  pageSize: 20 | 50 | 100;
  total: number;
  currencyTotals: Array<BillingAmount & { userPretaxAmount: number; platformPretaxAmount: number; userPretaxAmountExact?: string; platformPretaxAmountExact?: string }>;
  pendingResourceCount: number;
  pendingEntryCount?: number;
  entryTotal?: number;
  rowTotal?: number;
  billingStatusCounts?: Partial<Record<BillingDocumentStatus,number>>;
  filteredAmounts?: BillingAmount[];
  integrity?: { bookedRows: number; representedRows: number; unrepresentedRows: number };
  queryStatus: {
    lastRunAt: string | null;
    nextRunAt: string | null;
    queuedCount: number;
    runningCount: number;
    errorCount: number;
    errorResourceCount?: number;
  };
  batchSummaries?: Array<{id: string; name: string; memberCount: number; pendingResourceCount: number; pendingEntryCount?: number; amounts: BillingAmount[]}>;
};
export type BillingCharge = { id: string; resourceId: string; resourceType: string; name: string; category: string;
  status: 'issued' | 'unissued' | 'unknown' | 'not_returned'; amounts: BillingAmount[]; usage: string | null; usageUnit: string | null;
  billingFrom: string | null; billingTo: string | null; transactionType: string | null; message: string | null; rowCount: number };
export type BillingResourceFee = { resourceId: string; resourceType: string; amounts: BillingAmount[];
  specification?: { cpu?: number; memory?: string; systemDisk?: string; instanceType?: string; os?: string }; configurationChanged?: boolean };
export type BillingEntryDetail = { entry: BillingEntry; resources: BillingResource[]; events: BillingEvent[]; charges?: BillingCharge[]; resourceFees?: BillingResourceFee[] };
export type BillingEntriesQuery = BillingRange & {
  view: 'user' | 'platform'; userId?: string; page: number; pageSize: 20 | 50 | 100;
  groupBy?: 'batch'; billStatus?: BillingDocumentStatus;
};

const entriesCache = new Map<string, { at: number; value: BillingEntriesResult }>();
const detailsCache = new Map<string, { at: number; value: BillingEntryDetail }>();
const generations = new Map<string,number>();
let cacheSequence = 0;
export function billingSessionScope(token: string) {
  try {
    const encoded=token.split('.')[1];if(!encoded)return token;
    const claims=JSON.parse(atob(encoded.replaceAll('-','+').replaceAll('_','/'))) as Record<string,unknown>;
    if(!claims.sub||!claims.sid)return token;
    return JSON.stringify(Object.keys(claims).filter(key=>!['exp','iat','nbf','jti'].includes(key)).sort().map(key=>[key,claims[key]]));
  } catch { return token; }
}
const cacheKey = (context: BillingRequestContext, data: unknown) => JSON.stringify([context.apiBaseUrl,billingSessionScope(context.token),context.workspaceId,context.principalKey,data]);
const trim = (cache: Map<string,unknown>) => { if (cache.size > 64) { const key=cache.keys().next().value!;cache.delete(key);generations.delete(key); } };
export function readCachedBillingEntries(context: BillingRequestContext, query: BillingEntriesQuery) { return entriesCache.get(cacheKey(context,query))?.value; }
export function readCachedBillingDetail(context: BillingRequestContext, id: string, range: BillingRange) { return detailsCache.get(cacheKey(context,[id,range.startAt,range.endAt]))?.value; }
export function clearBillingReadCache() { entriesCache.clear(); detailsCache.clear(); generations.clear(); }

function billingUrl(context: BillingRequestContext, path: string, range: BillingRange) {
  const url = new URL(`${context.apiBaseUrl}/admin/billing/${path}`);
  url.searchParams.set('startAt', range.startAt);
  url.searchParams.set('endAt', range.endAt);
  return url;
}

export async function fetchBillingEntries(context: BillingRequestContext, query: BillingEntriesQuery, signal?: AbortSignal, options: { refresh?: boolean } = {}) {
  const key = cacheKey(context,query), cached = entriesCache.get(key);
  if (!options.refresh && cached && Date.now()-cached.at < 30_000) return cached.value;
  const url = billingUrl(context, 'entries', query);
  url.searchParams.set('view', query.view);
  if (query.view === 'user' && query.userId) url.searchParams.set('userId', query.userId);
  url.searchParams.set('page', String(query.page));
  url.searchParams.set('pageSize', String(query.pageSize));
  if (query.groupBy) url.searchParams.set('groupBy',query.groupBy);
  if (query.billStatus) url.searchParams.set('billStatus',query.billStatus);
  const generation = ++cacheSequence;
  generations.set(key,generation);
  try {
    const value = await readJson<BillingEntriesResult>(await fetch(url, {
      headers: { ...createAdminHeaders(context.token, context.workspaceId), ...(options.refresh ? { 'cache-control':'no-cache' } : {}) }, cache: 'no-store', signal,
    }));
    if (!signal?.aborted && generations.get(key) === generation) { entriesCache.set(key,{at:Date.now(),value}); trim(entriesCache); }
    return value;
  } finally { if (generations.get(key) === generation) generations.delete(key); }
}

export async function fetchBillingEntryDetail(context: BillingRequestContext, entryId: string, range: BillingRange, signal?: AbortSignal, options: { refresh?: boolean } = {}) {
  const key = cacheKey(context,[entryId,range.startAt,range.endAt]), cached = detailsCache.get(key);
  if (!options.refresh && cached && Date.now()-cached.at < 30_000) return cached.value;
  const generation = ++cacheSequence; generations.set(key,generation);
  try {
    const value = await readJson<BillingEntryDetail>(await fetch(billingUrl(context, `entries/${encodeURIComponent(entryId)}`, range), {
      headers: { ...createAdminHeaders(context.token, context.workspaceId), ...(options.refresh ? { 'cache-control':'no-cache' } : {}) }, cache: 'no-store', signal,
    }));
    if (!signal?.aborted && generations.get(key) === generation) { detailsCache.set(key,{at:Date.now(),value}); trim(detailsCache); }
    return value;
  } finally { if (generations.get(key) === generation) generations.delete(key); }
}

export async function reconcileBillingEntries(context: BillingRequestContext, input: BillingRange & { entryId?: string }) {
  return readJson<{ accepted: true; scheduledTasks: number; mode: string; note: string }>(await fetch(`${context.apiBaseUrl}/admin/billing/reconcile`, {
    method: 'POST', headers: createAdminHeaders(context.token, context.workspaceId), body: JSON.stringify(input),
  }));
}
