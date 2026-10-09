import { ForbiddenException } from '@nestjs/common';
import type { CloudWorkspaceScope, SystemCloudWorkspaceScope } from '../auth/cloud-workspace-scope';

const globalModels = new Set(['CloudWorkspace', 'CloudAccountContext', 'SystemCloudConfig']);
const writes = new Set(['create', 'createMany', 'createManyAndReturn', 'update', 'updateMany', 'updateManyAndReturn', 'delete', 'deleteMany', 'upsert']);

const compoundKeys: Record<string, string[]> = {
  PlatformUser: ['username'],
  IdempotentOperation: ['actorUserId_toolName_idempotencyKey'],
  CloudImageSnapshot: ['provider_accountScopeKey_regionId_scope_imageId'],
  ImageCatalogItem: ['provider_accountScopeKey_regionId_scope_imageId'],
  PlatformImageAsset: ['provider_accountScopeKey_regionId_imageId'],
  PlatformImageTag: ['normalizedName'],
  ImageImportJob: ['imageId', 'objectKey'],
  PackedImageArtifact: ['imageId'],
  RangeTemplate: ['slug_version'],
  SingleInstanceNetworkProfile: ['provider_cloudAccountUid_regionId_zoneId'],
  CloudResourceDrift: ['cloudProvider_regionId_cloudResourceType_cloudResourceId'],
  BillingLedgerResource: ['cloudProvider_regionId_cloudResourceId_cloudResourceType'],
  BillingLineItem: ['cloudProvider_sourceFingerprint'],
  BillingAnomaly: ['cloudProvider_sourceFingerprint'],
};

const relationModels: Record<string, Record<string, string>> = {
  PlatformUser: { platformImageAssets: 'PlatformImageAsset', createdImageTags: 'PlatformImageTag', rangeTemplates: 'RangeTemplate', rangeInstances: 'RangeInstance', singleInstanceBatches: 'SingleInstanceBatch', imageImportJobs: 'ImageImportJob' },
  CloudImageSnapshot: { catalogItems: 'ImageCatalogItem', platformAssets: 'PlatformImageAsset' },
  ImageImportJob: { ownerUser: 'PlatformUser', managedBucket: 'CloudImageImportBucket' },
  CloudImageImportBucket: { imageImportJobs: 'ImageImportJob' },
  ImageCatalogItem: { sourceSnapshot: 'CloudImageSnapshot' },
  PlatformImageAsset: { ownerUser: 'PlatformUser', sourceSnapshot: 'CloudImageSnapshot', tags: 'PlatformImageAssetTag' },
  PlatformImageTag: { createdByUser: 'PlatformUser', imageAssets: 'PlatformImageAssetTag' },
  PlatformImageAssetTag: { tag: 'PlatformImageTag', platformImageAsset: 'PlatformImageAsset' },
  RangeTemplate: { ownerUser: 'PlatformUser', versions: 'RangeTemplateVersion', currentDraftVersion: 'RangeTemplateVersion', currentPublishedVersion: 'RangeTemplateVersion', rangeInstances: 'RangeInstance' },
  RangeTemplateVersion: { template: 'RangeTemplate', currentDraftFor: 'RangeTemplate', currentPublishedFor: 'RangeTemplate' },
  SingleInstanceBatch: { ownerUser: 'PlatformUser', instances: 'RangeInstance' },
  RangeInstance: { ownerUser: 'PlatformUser', template: 'RangeTemplate', singleInstanceBatch: 'SingleInstanceBatch', jobs: 'ProvisionJob', lastJob: 'ProvisionJob' },
  ProvisionJob: { rangeInstance: 'RangeInstance', stepLogs: 'ProvisionJobStepLog', lastForInstance: 'RangeInstance' },
  ProvisionJobStepLog: { job: 'ProvisionJob' },
};

const requiredRelations = new Set(['ImageImportJob.ownerUser', 'PlatformImageAssetTag.tag', 'PlatformImageAssetTag.platformImageAsset', 'RangeTemplateVersion.template', 'ProvisionJob.rangeInstance', 'ProvisionJobStepLog.job']);

function object(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

export function scopePrismaWhere(model: string, where: unknown, cloudWorkspaceId: string, unique = true) {
  const scoped = { ...object(where) };
  for (const key of unique ? compoundKeys[model] ?? [] : []) {
    if (key in scoped) {
      const value = scoped[key];
      delete scoped[key];
      scoped[`cloudWorkspaceId_${key}`] = {
        ...(typeof value === 'object' ? value : { [key]: value }), cloudWorkspaceId,
      };
    }
    const scopedKey = `cloudWorkspaceId_${key}`;
    if (scopedKey in scoped) scoped[scopedKey] = { ...scoped[scopedKey], cloudWorkspaceId };
  }
  return { ...scoped, cloudWorkspaceId };
}

function scopeData(model: string, value: unknown, scope: CloudWorkspaceScope, creating: boolean): Record<string, any> {
  const data = { ...object(value) };
  if (model === 'CloudImageImportBucket' && !creating) {
    const identityFields = ['cloudWorkspaceId', 'cloudProvider', 'cloudAccountUid', 'cloudAccountContextId', 'appId', 'regionId', 'bucketName', 'creationNonce', 'creatorUserId', 'ownershipMarkerKey'];
    if (identityFields.some(field => field in data)) throw new ForbiddenException('Managed COS bucket creation identity is immutable');
    if ('activeSlot' in data && (data.activeSlot !== null || data.status !== 'deleted')) throw new ForbiddenException('Managed COS bucket active slot may only clear after deletion');
  }
  if ('cloudWorkspaceId' in data && data.cloudWorkspaceId !== scope.cloudWorkspaceId) {
    throw new ForbiddenException('Resources cannot move between cloud workspaces');
  }
  if (creating) {
    if (Object.keys(relationModels[model] ?? {}).some(field => data[field])) {
      delete data.cloudWorkspaceId;
      data.cloudWorkspace = { connect: { id: scope.cloudWorkspaceId } };
    } else data.cloudWorkspaceId = scope.cloudWorkspaceId;
  }
  for (const field of ['provider', 'cloudProvider']) {
    if (field in data && data[field] !== scope.provider) throw new ForbiddenException('Cloud provider does not match the selected workspace');
  }
  for (const field of ['accountUid', 'cloudAccountUid']) {
    if (data[field] != null && data[field] !== scope.accountUid) throw new ForbiddenException('Cloud account does not match the selected workspace');
  }
  for (const [field, target] of Object.entries(relationModels[model] ?? {})) {
    if (!(field in data)) continue;
    const nested = { ...object(data[field]) };
    for (const action of ['connect', 'disconnect', 'delete', 'deleteMany', 'set']) {
      if (nested[action] && nested[action] !== true) {
        const items = Array.isArray(nested[action]) ? nested[action] : [nested[action]];
        const scoped = items.map((item: unknown) => scopePrismaWhere(target, item, scope.cloudWorkspaceId, action !== 'deleteMany'));
        nested[action] = Array.isArray(nested[action]) ? scoped : scoped[0];
      }
    }
    if (nested.create) {
      nested.create = Array.isArray(nested.create)
        ? nested.create.map((item: unknown) => scopeData(target, item, scope, true))
        : scopeData(target, nested.create, scope, true);
    }
    if (nested.createMany) nested.createMany = { ...nested.createMany,
      data: (Array.isArray(nested.createMany.data) ? nested.createMany.data : [nested.createMany.data])
        .map((item: unknown) => scopeData(target, item, scope, true)) };
    for (const action of ['update', 'updateMany', 'upsert', 'connectOrCreate']) {
      if (!nested[action]) continue;
      const items = Array.isArray(nested[action]) ? nested[action] : [nested[action]];
      const scoped = items.map((item: unknown) => {
        const record = object(item);
        if (!('where' in record) && !['upsert', 'connectOrCreate'].includes(action)) return scopeData(target, record, scope, false);
        return { ...record, where: scopePrismaWhere(target, record.where, scope.cloudWorkspaceId, action !== 'updateMany'),
          ...(record.data ? { data: scopeData(target, record.data, scope, false) } : {}),
          ...(record.create ? { create: scopeData(target, record.create, scope, true) } : {}),
          ...(record.update ? { update: scopeData(target, record.update, scope, false) } : {}) };
      });
      nested[action] = Array.isArray(nested[action]) ? scoped : scoped[0];
    }
    data[field] = nested;
  }
  return data;
}

function scopeRelations(model: string, args: Record<string, any>, scope: CloudWorkspaceScope) {
  for (const key of ['include', 'select']) {
    if (!args[key]) continue;
    const selection = { ...args[key] };
    for (const [field, target] of Object.entries(relationModels[model] ?? {})) {
      if (!selection[field]) continue;
      const nested = { ...object(selection[field]) };
      if (requiredRelations.has(`${model}.${field}`)) {
        // Prisma cannot filter required to-one relations; verify their scope before returning them.
        if (nested.select) nested.select = { ...nested.select, cloudWorkspaceId: true };
      } else nested.where = { ...object(nested.where), cloudWorkspaceId: scope.cloudWorkspaceId };
      scopeRelations(target, nested, scope);
      selection[field] = nested;
    }
    args[key] = selection;
  }
}

export function scopePrismaQuery(model: string, operation: string, value: unknown,
  scope: CloudWorkspaceScope | SystemCloudWorkspaceScope | null): Record<string, any> {
  const args = { ...object(value) };
  if (globalModels.has(model) || scope && 'system' in scope) return args;
  if (!scope) return args;
  if (scope.isReadOnly && writes.has(operation) && !['OperationConfirmation', 'IdempotentOperation', 'OperationAuditEvent'].includes(model)) throw new ForbiddenException('Historical cloud workspace is read-only');
  if (operation !== 'create' && operation !== 'createMany' && operation !== 'createManyAndReturn') {
    args.where = scopePrismaWhere(model, args.where, scope.cloudWorkspaceId, ['findUnique', 'findUniqueOrThrow', 'update', 'delete', 'upsert'].includes(operation));
  }
  if (operation === 'create' || operation === 'update' || operation === 'updateMany' || operation === 'updateManyAndReturn') {
    args.data = scopeData(model, args.data, scope, operation === 'create');
  }
  if (operation === 'createMany' || operation === 'createManyAndReturn') {
    args.data = (Array.isArray(args.data) ? args.data : [args.data]).map((item: unknown) => scopeData(model, item, scope, true));
  }
  if (operation === 'upsert') {
    args.create = scopeData(model, args.create, scope, true);
    args.update = scopeData(model, args.update, scope, false);
  }
  scopeRelations(model, args, scope);
  return args;
}

export function scopePrismaResult(model: string, value: any, originalArgs: unknown,
  scope: CloudWorkspaceScope | SystemCloudWorkspaceScope | null): any {
  if (!scope || 'system' in scope || value == null || globalModels.has(model)) return value;
  if (Array.isArray(value)) return value.map(item => scopePrismaResult(model, item, originalArgs, scope));
  const args = object(originalArgs);
  for (const key of ['include', 'select']) {
    const selection = object(args[key]);
    for (const [field, target] of Object.entries(relationModels[model] ?? {})) {
      if (!selection[field] || value[field] == null) continue;
      const nestedArgs = object(selection[field]);
      if (requiredRelations.has(`${model}.${field}`) && value[field].cloudWorkspaceId !== scope.cloudWorkspaceId) {
        value[field] = null;
        continue;
      }
      value[field] = scopePrismaResult(target, value[field], nestedArgs, scope);
      if (requiredRelations.has(`${model}.${field}`) && nestedArgs.select && nestedArgs.select.cloudWorkspaceId !== true) delete value[field].cloudWorkspaceId;
    }
  }
  return value;
}
