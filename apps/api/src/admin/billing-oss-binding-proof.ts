import { createHmac } from 'node:crypto';

import type { BillingLedgerResourceRecord } from './admin.repository';
import type { SystemCloudAccountContext } from './system-config.service';

export const ALIYUN_OSS_DEDICATED_BILLING_KEY = 'aliyunOssDedicatedBilling';
export type AliyunOssPlatformCreationProof = {
  version: 1; managedBucketId: string; creationNonce: string; preflightAbsentAt: string; preflightRequestId: string;
  creationStartedAt: string; creationRequestId: string | null; aclVerifiedAt: string; aclRequestId: string;
  ownerUid: string; storageClass: 'Standard'; taggingVerifiedAt: string; taggingRequestId: string;
  atomicTags: { PlatformManagedBucketId: string; PlatformCreationNonce: string; CloudWorkspaceId: string };
};
export type AliyunOssDedicatedBillingProof = {
  version: 1; dedicated: true; cloudWorkspaceId: string; cloudAccountUid: string; cloudAccountContextId: string;
  bucketName: string; regionId: string; bucketCreatedAt: string; verifiedAt: string; officialRequestId: string;
  declaredAt: string; declaredByUserId: string; effectiveStartAt: string; effectiveEndAt: string | null;
  platformCreation?: AliyunOssPlatformCreationProof;
};
export type AliyunOssBucketIdentity = { bucketName: string; regionId: string; ownerUid: string; bucketCreatedAt: string; officialRequestId: string; verifiedAt: string };
export const OSS_BUCKET_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

function isoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

export function readAliyunOssDedicatedBilling(ledger: BillingLedgerResourceRecord): AliyunOssDedicatedBillingProof | null {
  const raw = ledger.tagsSnapshot[ALIYUN_OSS_DEDICATED_BILLING_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const proof = raw as AliyunOssDedicatedBillingProof;
  if (ledger.cloudProvider !== 'alibaba_cloud' || ledger.cloudResourceType !== 'oss_bucket' || ledger.billingScope !== 'platform'
    || ledger.ownerUserId !== null || ledger.rangeInstanceId !== null || ledger.singleInstanceBatchId !== null
    || ledger.platformImageAssetId !== null || ledger.sourceProvisionJobId !== null || ledger.releasedAt !== null
    || proof.version !== 1 || proof.dedicated !== true || !proof.cloudWorkspaceId || proof.cloudWorkspaceId === 'legacy-unbound'
    || proof.cloudWorkspaceId !== ledger.cloudWorkspaceId || !/^\d+$/.test(proof.cloudAccountUid) || proof.cloudAccountUid !== ledger.cloudAccountUid
    || !proof.cloudAccountContextId || !OSS_BUCKET_NAME_PATTERN.test(proof.bucketName) || proof.bucketName !== ledger.cloudResourceId
    || !/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(proof.regionId) || proof.regionId !== ledger.regionId
    || !proof.declaredByUserId || typeof proof.officialRequestId !== 'string' || !proof.officialRequestId
    || !isoTimestamp(proof.bucketCreatedAt) || !isoTimestamp(proof.verifiedAt) || !isoTimestamp(proof.declaredAt)
    || !isoTimestamp(proof.effectiveStartAt) || proof.effectiveStartAt !== ledger.billingStartAt.toISOString()
    || Date.parse(proof.bucketCreatedAt) > Date.parse(proof.verifiedAt) || Date.parse(proof.bucketCreatedAt) > Date.parse(proof.effectiveStartAt)
    || Date.parse(proof.effectiveStartAt) > Date.parse(proof.declaredAt) || Date.parse(proof.declaredAt) > ledger.createdAt.getTime()
    || proof.effectiveEndAt !== null && (!isoTimestamp(proof.effectiveEndAt) || Date.parse(proof.effectiveEndAt) < Date.parse(proof.effectiveStartAt)
      || Date.parse(proof.effectiveEndAt) > ledger.updatedAt.getTime())) return null;
  if (proof.platformCreation && !validPlatformCreation(proof)) return null;
  return proof;
}

function validPlatformCreation(proof: AliyunOssDedicatedBillingProof): boolean {
  const birth = proof.platformCreation!;
  return birth.version === 1 && typeof birth.managedBucketId === 'string' && !!birth.managedBucketId
    && typeof birth.creationNonce === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(birth.creationNonce)
    && proof.bucketName === `for-platform-${birth.creationNonce.replaceAll('-', '')}`
    && typeof birth.preflightRequestId === 'string' && !!birth.preflightRequestId
    && (birth.creationRequestId === null || typeof birth.creationRequestId === 'string' && !!birth.creationRequestId)
    && typeof birth.aclRequestId === 'string' && !!birth.aclRequestId && birth.ownerUid === proof.cloudAccountUid
    && typeof birth.taggingRequestId === 'string' && !!birth.taggingRequestId && isoTimestamp(birth.taggingVerifiedAt)
    && birth.atomicTags?.PlatformManagedBucketId === birth.managedBucketId
    && birth.atomicTags?.PlatformCreationNonce === birth.creationNonce
    && birth.atomicTags?.CloudWorkspaceId === proof.cloudWorkspaceId
    && birth.storageClass === 'Standard' && isoTimestamp(birth.preflightAbsentAt) && isoTimestamp(birth.creationStartedAt)
    && isoTimestamp(birth.aclVerifiedAt) && Date.parse(birth.preflightAbsentAt) <= Date.parse(birth.creationStartedAt)
    // OSS CreationDate has second precision, while the durable preflight uses milliseconds.
    && Date.parse(birth.creationStartedAt) <= Date.parse(proof.bucketCreatedAt) + 1000
    && Date.parse(proof.bucketCreatedAt) <= Date.parse(birth.creationStartedAt) + 120_000
    && Date.parse(proof.bucketCreatedAt) <= Date.parse(birth.taggingVerifiedAt)
    && Date.parse(birth.taggingVerifiedAt) <= Date.parse(proof.declaredAt)
    && Date.parse(proof.bucketCreatedAt) <= Date.parse(birth.aclVerifiedAt)
    && Date.parse(birth.aclVerifiedAt) <= Date.parse(proof.declaredAt);
}

export function aliyunOssBindingCoversBillingDay(proof: AliyunOssDedicatedBillingProof, billingDate: Date | string): boolean {
  const time = typeof billingDate === 'string' ? Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(billingDate) ? `${billingDate}T00:00:00+08:00` : billingDate) : billingDate.getTime();
  if (!Number.isFinite(time)) return false;
  const date = new Date(time + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const dayStart = Date.parse(`${date}T00:00:00+08:00`);
  const createdDuringDay = !!proof.platformCreation && validPlatformCreation(proof) && !!proof.platformCreation.creationRequestId
    && proof.effectiveStartAt === proof.bucketCreatedAt && Date.parse(proof.bucketCreatedAt) >= dayStart
    && Date.parse(proof.bucketCreatedAt) < dayStart + 86_400_000;
  return (Date.parse(proof.effectiveStartAt) <= dayStart || createdDuringDay)
    && (proof.effectiveEndAt === null || Date.parse(proof.effectiveEndAt) >= dayStart + 24 * 60 * 60 * 1000);
}

export function aliyunOssBindingOverlapsBillingDay(proof: AliyunOssDedicatedBillingProof, billingDate: string): boolean {
  const start = Date.parse(`${billingDate}T00:00:00+08:00`);
  return Number.isFinite(start) && Date.parse(proof.effectiveStartAt) < start + 86_400_000
    && (proof.effectiveEndAt === null || Date.parse(proof.effectiveEndAt) > start);
}

function element(xml: string, name: string) {
  const matches = [...xml.matchAll(new RegExp(`<${name}>([^<]*)</${name}>`, 'g'))];
  if (matches.length !== 1 || /&/.test(matches[0][1])) throw new Error('OSS_BUCKET_IDENTITY_INVALID');
  return matches[0][1].trim();
}

export async function readAliyunOssBucketIdentity(context: SystemCloudAccountContext, bucketName: string): Promise<AliyunOssBucketIdentity> {
  if (context.provider !== 'alibaba_cloud' || !context.accountUidResolved || !context.accountUid || !/^\d+$/.test(context.accountUid)
    || !OSS_BUCKET_NAME_PATTERN.test(bucketName) || !/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(context.defaultRegion)
    || !context.accessKeyId || !context.accessKeySecret) throw new Error('OSS_BUCKET_CONTEXT_INVALID');
  const date = new Date().toUTCString();
  const signature = createHmac('sha1', context.accessKeySecret).update(`GET\n\n\n${date}\n/${bucketName}/?bucketInfo`).digest('base64');
  const response = await fetch(`https://${bucketName}.oss-${context.defaultRegion}.aliyuncs.com/?bucketInfo`, {
    method: 'GET', redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { Date: date, Authorization: `OSS ${context.accessKeyId}:${signature}` },
  });
  if (!response.ok) throw new Error(`OSS_BUCKET_VERIFY_HTTP_${response.status}`);
  const xml = await response.text();
  const officialRequestId = response.headers.get('x-oss-request-id');
  if (!officialRequestId || xml.length > 65_536 || /<!DOCTYPE|<!ENTITY/i.test(xml)
    || !/^\s*(?:<\?xml[^?]*\?>\s*)?<BucketInfo>/.test(xml)) throw new Error('OSS_BUCKET_IDENTITY_INVALID');
  const bucket = /<Bucket>([\s\S]*?)<\/Bucket>/.exec(xml)?.[1];
  const owner = bucket && /<Owner>([\s\S]*?)<\/Owner>/.exec(bucket)?.[1];
  if (!bucket || !owner) throw new Error('OSS_BUCKET_IDENTITY_INVALID');
  const name = element(bucket, 'Name');
  const regionId = element(bucket, 'Location').replace(/^oss-/, '');
  const ownerUid = element(owner, 'ID');
  const createdText = element(bucket, 'CreationDate');
  const created = Date.parse(createdText);
  if (name !== bucketName || regionId !== context.defaultRegion || ownerUid !== context.accountUid
    || !Number.isFinite(created) || created > Date.now()) throw new Error('OSS_BUCKET_IDENTITY_MISMATCH');
  return { bucketName: name, regionId, ownerUid, bucketCreatedAt: new Date(created).toISOString(), officialRequestId, verifiedAt: new Date().toISOString() };
}

export async function refreshAliyunOssBindingVerification(ledger: BillingLedgerResourceRecord, context: SystemCloudAccountContext): Promise<{ verified: boolean; reason: string | null }> {
  const proof = readAliyunOssDedicatedBilling(ledger);
  if (!proof || proof.cloudAccountUid !== context.accountUid || proof.cloudAccountContextId !== context.cloudAccountContextId
    || proof.regionId !== context.defaultRegion) return { verified: false, reason: 'OSS_BUCKET_BINDING_IDENTITY_INVALID' };
  try {
    const identity = await readAliyunOssBucketIdentity(context, proof.bucketName);
    return identity.bucketCreatedAt === proof.bucketCreatedAt ? { verified: true, reason: null }
      : { verified: false, reason: 'OSS_BUCKET_RECREATED' };
  } catch (error) {
    return { verified: false, reason: error instanceof Error && /^OSS_BUCKET_[A-Z_0-9]+$/.test(error.message) ? error.message : 'OSS_BUCKET_VERIFICATION_UNAVAILABLE' };
  }
}
