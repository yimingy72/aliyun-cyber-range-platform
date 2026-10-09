import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { ADMIN_REPOSITORY, type AdminRepository, type SingleInstanceNetworkProfileRecord, type OperationAuditPhase, type UpsertSingleInstanceNetworkProfileInput } from './admin.repository';
import { SystemConfigService, type SystemCloudAccountContext } from './system-config.service';
import { CidrPoolService } from '../provisioning/cidr-pool.service';
import { SingleInstanceNetworkBootstrapService, singleNetworkWorkspaceKey } from '../provisioning/single-instance-network-bootstrap';
import type { SessionUserProfile } from './admin-user-auth';
import { SingleInstanceBatchExecutionService } from './single-instance-batch-execution.service';
@Injectable()
export class SingleInstanceNetworkService {
  constructor(
    @Inject(ADMIN_REPOSITORY) private readonly adminRepository: AdminRepository,
    private readonly systemConfigService: SystemConfigService,
    private readonly bootstrap: SingleInstanceNetworkBootstrapService,
    private readonly cidrPoolService: CidrPoolService,
    @Optional() private readonly execution?: SingleInstanceBatchExecutionService,
  ) {}

  async ensureDefaultProfile(account?: SystemCloudAccountContext,creatorUserId?:string) {
    return this.cidrPoolService.serialize(async () => {
      const snapshot = account ?? await this.systemConfigService.getAccountContext();
      if (!snapshot.accountUid || !snapshot.cloudAccountContextId)
        throw new ConflictException('Default network requires a verified cloud account');
      const identity = { createdByUserId:creatorUserId,provider: snapshot.provider, cloudAccountUid: snapshot.accountUid, cloudAccountContextId: snapshot.cloudAccountContextId, regionId: snapshot.defaultRegion, zoneId: snapshot.defaultZoneId };
      const existing = await this.adminRepository.getSingleInstanceNetworkProfile(identity);
      if (existing) {
        if(existing.cleanupRunId && !existing.cleanupOwnerUserIds?.includes(creatorUserId??'')) throw new ConflictException('Default network is reserved for an explicitly registered validation run');
        if (existing.status === 'destroying' || !existing.vpcId || !existing.securityGroupId || existing.vswitchIds.length !== 3)
          throw new ConflictException(`Default network cleanup is required for profile ${existing.id}`);
        return existing;
      }
      const occupied = (await this.adminRepository.listRangeInstances()).map(value => value.allocatedCidr).filter((value): value is string => Boolean(value));
      occupied.push(...(await this.adminRepository.listSingleInstanceNetworkProfiles()).map(profile => profile.vpcCidr));
      let pendingProfile: SingleInstanceNetworkProfileRecord | null = null;
      let cleanupVerified = false;
      const recordPending = async (recovery: UpsertSingleInstanceNetworkProfileInput) => {
        pendingProfile = await this.adminRepository.upsertSingleInstanceNetworkProfile({ ...recovery, ...identity, status: 'destroying' });
        return pendingProfile;
      };
      try {
        const profile = await this.bootstrap.bootstrapDefaultProfile({
          ...identity, occupiedCidrs: occupied, runtimeConfig: snapshot,
          onApplyStart: async () => {
            const recovery = await this.bootstrap.readRecoveryProfile(identity);
            if (!recovery) throw new ConflictException('Default network apply intent could not be persisted');
            const pending = await recordPending(recovery);
            await this.auditNetwork(pending, creatorUserId, 'bootstrap', 'dispatched');
          },
          onCleanupStart: async recovery => {
            const pending = await recordPending(recovery);
            await this.auditNetwork(pending, creatorUserId, 'bootstrap_cleanup', 'dispatched');
          },
          onCleanupVerified: async () => {
            pendingProfile ??= await this.adminRepository.getSingleInstanceNetworkProfile(identity);
            if (pendingProfile) {
              if (pendingProfile.status !== 'destroying' || !pendingProfile.managedByPlatform ||
                  pendingProfile.cloudAccountContextId !== identity.cloudAccountContextId ||
                  pendingProfile.workspaceKey !== singleNetworkWorkspaceKey(identity.cloudAccountUid, identity.regionId, identity.zoneId))
                throw new ConflictException('Default network cleanup intent identity does not match');
              await this.auditNetwork(pendingProfile, creatorUserId, 'bootstrap', 'failed', 'NETWORK_BOOTSTRAP_FAILED_CLEANED');
              await this.auditNetwork(pendingProfile, creatorUserId, 'bootstrap_cleanup', 'succeeded');
              await this.adminRepository.deleteSingleInstanceNetworkProfile(pendingProfile.id);
              pendingProfile = null;
            }
            cleanupVerified = true;
          },
        });
        const ready = await this.adminRepository.upsertSingleInstanceNetworkProfile({ ...profile, ...identity, status: 'ready' });
        await this.auditNetwork(ready, creatorUserId, 'bootstrap', 'succeeded');
        return ready;
      }
      catch (error) {
        if (!cleanupVerified) {
          const recovery = await this.bootstrap.readRecoveryProfile(identity);
          if (recovery) {
            // An empty post-cleanup state must not erase IDs already retained before compensation.
            const retained = pendingProfile as SingleInstanceNetworkProfileRecord | null;
            const pending = await recordPending({ ...recovery,
              vpcId: recovery.vpcId || retained?.vpcId || '',
              securityGroupId: recovery.securityGroupId || retained?.securityGroupId || '',
              vswitchIds: [...new Set([...(retained?.vswitchIds ?? []), ...recovery.vswitchIds])],
            });
            await this.auditNetwork(pending, creatorUserId, 'bootstrap', 'failed', 'NETWORK_RECOVERY_REQUIRED');
            throw new ConflictException(`Default network cleanup is required for profile ${pending.id}`);
          }
        }
        throw error;
      }
    });
  }
  list(currentUser: SessionUserProfile) {
    this.assertAdmin(currentUser);
    return this.adminRepository.listSingleInstanceNetworkProfiles();
  }
  async registerCleanup(id:string,runId:string,createdAfter:string,ownerUserIds:string[],admin:SessionUserProfile) {
    this.assertAdmin(admin);
    const start=new Date(createdAfter);
    if(typeof runId!=='string'||!runId.trim()||!Number.isFinite(start.getTime())||start>new Date()
      ||!Array.isArray(ownerUserIds)||!ownerUserIds.length||ownerUserIds.length>99||ownerUserIds.some(value=>typeof value!=='string'||!value.trim())) throw new ConflictException('Cleanup registration requires a run ID, start time, and exact temporary owner IDs');
    return this.adminRepository.withSingleInstanceControlLock(async()=>{
      const profile=await this.requireProfile(id);
      if(!profile.managedByPlatform||!profile.createdByUserId||profile.createdAt<start||!ownerUserIds.includes(profile.createdByUserId)) throw new ConflictException('Only this-run newly created profiles belonging to the declared owners can be registered');
      if(profile.cleanupRunId&&(profile.cleanupRunId!==runId||profile.cleanupRegisteredByUserId!==admin.id)) throw new ConflictException('Profile is already registered to a different cleanup run');
      const foreign=(await this.adminRepository.listRangeInstances()).some(instance=>instance.singleInstanceConfig?.networkProfileId===id&&!ownerUserIds.includes(instance.ownerUserId??''));
      if(foreign) throw new ConflictException('Profile has references outside the declared validation owners');
      await this.adminRepository.registerSingleInstanceNetworkCleanup(id,runId,admin.id,[...new Set(ownerUserIds)]);
      return {networkProfileId:id,cleanupRunId:runId,ownerUserIds};
    });
  }

  async prepareDestroy(id: string, currentUser: SessionUserProfile) {
    this.assertAdmin(currentUser);
    const profile = await this.requireProfile(id);
    return { targetId: id, targetSnapshot: { vpcId: profile.vpcId, cloudAccountUid: profile.cloudAccountUid, regionId: profile.regionId, workspaceKey: profile.workspaceKey }, summary: { targetName: profile.id, destructive: true } };
  }
  async destroy(id: string, currentUser: SessionUserProfile, cleanupRunId?:string) {
    this.assertAdmin(currentUser);
    return this.adminRepository.withSingleInstanceControlLock(async () => {
      const profile = await this.requireProfile(id);
      if(!cleanupRunId||profile.cleanupRunId!==cleanupRunId||profile.cleanupRegisteredByUserId!==currentUser.id) throw new ConflictException('Network cleanup requires its pre-registered run ID and registering administrator');
      if (!profile.managedByPlatform || !profile.cloudAccountContextId)
        throw new ConflictException('Legacy or unbound shared networks cannot be destroyed through this endpoint');
      const account = await this.systemConfigService.getAccountContextById(profile.cloudAccountContextId);
      if (account.accountUid !== profile.cloudAccountUid || account.defaultRegion !== profile.regionId)
        throw new ConflictException('Network cloud source does not match its persisted identity');
      const references = (await this.adminRepository.listRangeInstances()).filter(instance => instance.singleInstanceConfig?.networkProfileId === id || instance.resourceSummary?.vpcId === profile.vpcId || profile.vswitchIds.includes(instance.singleInstanceConfig?.assignedVswitchId ?? ''));
      if (references.some(instance => !['destroyed', 'create_failed'].includes(instance.status) || instance.status === 'create_failed' && Object.values(instance.resourceSummary?.hostIds ?? {}).length))
        throw new ConflictException('Default network is still referenced by an active or uncleared instance');
      if(references.some(instance=>!profile.cleanupOwnerUserIds?.includes(instance.ownerUserId??''))) throw new ConflictException('Network includes references outside this validation run');
      const ids = new Set(references.map(instance => instance.id));
      if ((await this.adminRepository.listProvisionJobs()).some(job => ids.has(job.rangeInstanceId) && ['pending', 'running'].includes(job.status)))
        throw new ConflictException('Default network still has resource jobs');
      if (!this.execution)
        throw new ConflictException('Network lifecycle executor unavailable');
      await this.auditNetwork(profile, currentUser.id, 'destroy', 'requested');
      await this.adminRepository.markSingleInstanceNetworkDestroying(id);
      try {
        await this.execution.assertNetworkUnused(profile, account);
        let cleanupVerified = false;
        await this.bootstrap.destroyDefaultProfile(profile, account, async () => {
          await this.auditNetwork(profile, currentUser.id, 'destroy', 'succeeded');
          await this.adminRepository.deleteSingleInstanceNetworkProfile(id);
          cleanupVerified = true;
        });
        if (!cleanupVerified) throw new ConflictException('Default network cleanup verification was not completed');
      } catch (error) {
        await this.auditNetwork(profile, currentUser.id, 'destroy', 'failed', 'NETWORK_CLEANUP_FAILED');
        throw error;
      }
      return { networkProfileId: id, status: 'destroyed', vpcId: profile.vpcId, vswitchIds: profile.vswitchIds, securityGroupId: profile.securityGroupId };
    });
  }
  allocateVswitch(profile: SingleInstanceNetworkProfileRecord, offset: number) {
    const index = Math.abs(offset) % Math.min(profile.vswitchIds.length, profile.vswitchCidrs.length, 3);
    const [network] = profile.vswitchCidrs[index].split('/');
    const parts = network.split('.');
    return { vswitchId: profile.vswitchIds[index], vswitchCidr: profile.vswitchCidrs[index], zoneKey: `zone-${index + 1}`, privateIp: `${parts[0]}.${parts[1]}.${parts[2]}.${10 + (Math.abs(offset) % 200)}` };
  }
  private auditNetwork(profile: SingleInstanceNetworkProfileRecord, actorUserId: string | undefined,
    action: 'bootstrap' | 'bootstrap_cleanup' | 'destroy', phase: OperationAuditPhase, errorCode?: string) {
    const operationId = `single-network:${profile.id}:${action}`;
    return this.adminRepository.appendOperationAuditEvent({
      operationId, requestId: operationId, actorUserId: actorUserId ?? profile.createdByUserId ?? 'system',
      source: 'system', toolName: `single_instance_network_${action}`, phase,
      targetType: 'single_instance_network', targetId: profile.id, errorCode,
      sanitizedInput: {
        networkProfileId: profile.id, cloudAccountUid: profile.cloudAccountUid,
        cloudAccountContextId: profile.cloudAccountContextId, regionId: profile.regionId, zoneId: profile.zoneId,
        workspaceKey: profile.workspaceKey, vpcId: profile.vpcId, vpcCidr: profile.vpcCidr,
        vswitchIds: profile.vswitchIds, vswitchCidrs: profile.vswitchCidrs, securityGroupId: profile.securityGroupId,
        cleanupRunId: profile.cleanupRunId, cleanupVerified: phase === 'succeeded' && action !== 'bootstrap',
      },
    });
  }

  private assertAdmin(user: SessionUserProfile) {
    if (user.role !== 'admin') throw new ForbiddenException('Only administrators can inspect or destroy shared networks');
  }

  private async requireProfile(id: string) {
    const profile = await this.adminRepository.getSingleInstanceNetworkProfileById(id);
    if (!profile) throw new NotFoundException('Single-instance network profile not found');
    return profile;
  }
}
