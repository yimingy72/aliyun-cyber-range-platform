import { BadGatewayException, BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import { getCurrentCloudWorkspaceScope, requireCurrentCloudWorkspaceId } from '../auth/cloud-workspace-scope';
import { ADMIN_REPOSITORY, type AdminRepository, type BillingLedgerResourceRecord } from './admin.repository';
import { readPlatformBillingStartedAt } from './billing-current-scope';
import { ALIYUN_OSS_DEDICATED_BILLING_KEY, OSS_BUCKET_NAME_PATTERN, readAliyunOssBucketIdentity, readAliyunOssDedicatedBilling, type AliyunOssDedicatedBillingProof } from './billing-oss-binding-proof';
import type { BindBillingOssBucketDto, OssBillingBindingDto } from './dto/billing-oss-binding.dto';
import { SystemConfigService, type SystemCloudAccountContext } from './system-config.service';

@Injectable()
export class BillingOssBindingService {
  constructor(@Inject(ADMIN_REPOSITORY) private readonly repository: AdminRepository, private readonly config: SystemConfigService) {}

  async list(): Promise<OssBillingBindingDto[]> {
    const workspaceId = requireCurrentCloudWorkspaceId();
    return (await this.repository.listBillingLedgerResources()).flatMap(ledger => {
      const proof = readAliyunOssDedicatedBilling(ledger);
      return proof && proof.cloudWorkspaceId === workspaceId ? [this.dto(ledger, proof)] : [];
    });
  }

  async confirmation(payload: BindBillingOssBucketDto) {
    const context = await this.contextForWrite();
    this.validatePayload(payload, context);
    return { targetId: payload.bucketName, targetSnapshot: { bucketName: payload.bucketName, accountUid: context.accountUid, regionId: context.defaultRegion },
      summary: { bucketName: payload.bucketName, accountUid: context.accountUid, regionId: context.defaultRegion,
        effectiveStartAt: new Date(Math.max(Date.parse(payload.effectiveStartAt), readPlatformBillingStartedAt()?.getTime() ?? 0)).toISOString(),
        dedicated: true, includesStorageRequestsAndTraffic: true, createsOrDeletesCloudResources: false } };
  }

  async bind(payload: BindBillingOssBucketDto): Promise<OssBillingBindingDto> {
    const context = await this.contextForWrite();
    this.validatePayload(payload, context);
    let identity;
    try { identity = await readAliyunOssBucketIdentity(context, payload.bucketName); }
    catch { throw new BadGatewayException('无法取得与当前账号及地域一致的官方 OSS 桶身份，未绑定费用。'); }
    const billingStartAt = new Date(Math.max(Date.parse(payload.effectiveStartAt), Date.parse(identity.bucketCreatedAt), readPlatformBillingStartedAt()?.getTime() ?? 0));
    const workspaceId = requireCurrentCloudWorkspaceId();
    const find = { cloudWorkspaceId: workspaceId, cloudProvider: 'alibaba_cloud' as const, regionId: context.defaultRegion,
      cloudResourceId: payload.bucketName, cloudResourceType: 'oss_bucket' as const };
    const acceptExisting = (ledger: BillingLedgerResourceRecord): OssBillingBindingDto => {
      const proof = readAliyunOssDedicatedBilling(ledger);
      if (!proof || proof.effectiveEndAt !== null || proof.cloudAccountUid !== context.accountUid
        || proof.cloudAccountContextId !== context.cloudAccountContextId || proof.bucketCreatedAt !== identity.bucketCreatedAt
        || proof.effectiveStartAt !== billingStartAt.toISOString()) throw new ConflictException('该桶已有不同来源或已终止的费用声明，不能覆盖历史归属。');
      return this.dto(ledger, proof);
    };
    const existing = await this.repository.findBillingLedgerResource(find);
    if (existing) return acceptExisting(existing);
    const declaredAt = new Date().toISOString();
    const scope = getCurrentCloudWorkspaceScope();
    const proof: AliyunOssDedicatedBillingProof = { version: 1, dedicated: true, cloudWorkspaceId: workspaceId,
      cloudAccountUid: context.accountUid!, cloudAccountContextId: context.cloudAccountContextId!, bucketName: payload.bucketName,
      regionId: context.defaultRegion, bucketCreatedAt: identity.bucketCreatedAt, verifiedAt: identity.verifiedAt,
      officialRequestId: identity.officialRequestId, declaredAt, declaredByUserId: scope && !('system' in scope) ? scope.actorUserId! : '',
      effectiveStartAt: billingStartAt.toISOString(), effectiveEndAt: null };
    try {
      const ledger = await this.repository.createBillingLedgerResource({ ...find, cloudAccountUid: context.accountUid,
        billingScope: 'platform', billingStartAt, tagsSnapshot: { [ALIYUN_OSS_DEDICATED_BILLING_KEY]: proof } });
      return this.dto(ledger, proof);
    } catch (error) {
      const concurrent = await this.repository.findBillingLedgerResource(find);
      if (concurrent) return acceptExisting(concurrent);
      throw error;
    }
  }

  async endConfirmation(ledgerId: string) {
    this.assertManager();
    const { ledger, proof } = await this.boundLedger(ledgerId);
    return { targetId: ledger.id, targetSnapshot: { bucketName: proof.bucketName, effectiveStartAt: proof.effectiveStartAt },
      summary: { bucketName: proof.bucketName, endsDedicatedBilling: true, deletesCloudResources: false,
        retainsVerifiedHistoricalCharges: true, cannotAutomaticallyResume: true } };
  }

  async end(ledgerId: string): Promise<OssBillingBindingDto> {
    this.assertManager();
    const { ledger, proof } = await this.boundLedger(ledgerId);
    if (proof.effectiveEndAt !== null) return this.dto(ledger, proof);
    const endedAt = new Date();
    await this.repository.endOssBillingBinding(ledger, endedAt);
    const latest = await this.boundLedger(ledgerId);
    if (latest.proof.effectiveEndAt === null) throw new ConflictException('费用声明已经变化，请重新读取后操作。');
    return this.dto(latest.ledger, latest.proof);
  }

  private assertManager() {
    const scope = getCurrentCloudWorkspaceScope();
    if (!scope || 'system' in scope || scope.isPlatformManager !== true || !scope.actorUserId || scope.isReadOnly) {
      throw new ForbiddenException('仅平台超管可声明或终止专用桶费用归属。');
    }
    return scope;
  }

  private async contextForWrite(): Promise<SystemCloudAccountContext> {
    const scope = this.assertManager();
    const context = await this.config.getSelectedAccountContext();
    if (scope.provider !== 'alibaba_cloud' || context.provider !== 'alibaba_cloud' || !context.accountUidResolved
      || !context.accountUid || context.accountUid !== scope.accountUid || !context.cloudAccountContextId
      || context.cloudAccountContextId !== scope.cloudAccountContextId || !context.imageImportBucket) {
      throw new BadRequestException('请选择已验证的阿里云账号并配置 OSS 导入桶。');
    }
    return context;
  }

  private validatePayload(payload: BindBillingOssBucketDto, context: SystemCloudAccountContext) {
    if (payload.dedicated !== true || !OSS_BUCKET_NAME_PATTERN.test(payload.bucketName) || payload.bucketName !== context.imageImportBucket
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(payload.effectiveStartAt)
      || !Number.isFinite(Date.parse(payload.effectiveStartAt)) || Date.parse(payload.effectiveStartAt) > Date.now()) {
      throw new BadRequestException('必须声明当前配置桶仅用于平台，并指定不晚于当前时间的固定费用起点。');
    }
  }

  private async boundLedger(ledgerId: string) {
    const workspaceId = requireCurrentCloudWorkspaceId();
    const ledger = (await this.repository.listBillingLedgerResources()).find(row => row.id === ledgerId && row.cloudWorkspaceId === workspaceId);
    const proof = ledger && readAliyunOssDedicatedBilling(ledger);
    if (!ledger || !proof) throw new NotFoundException('当前工作空间没有该专用桶费用声明。');
    return { ledger, proof };
  }

  private dto(ledger: BillingLedgerResourceRecord, proof: AliyunOssDedicatedBillingProof): OssBillingBindingDto {
    return { ledgerId: ledger.id, bucketName: proof.bucketName, cloudWorkspaceId: proof.cloudWorkspaceId, cloudAccountUid: proof.cloudAccountUid,
      regionId: proof.regionId, effectiveStartAt: proof.effectiveStartAt, effectiveEndAt: proof.effectiveEndAt,
      declaredAt: proof.declaredAt, declaredByUserId: proof.declaredByUserId, bucketCreatedAt: proof.bucketCreatedAt,
      verifiedAt: proof.verifiedAt, officialRequestId: proof.officialRequestId, status: proof.effectiveEndAt === null ? 'active' : 'ended' };
  }
}
