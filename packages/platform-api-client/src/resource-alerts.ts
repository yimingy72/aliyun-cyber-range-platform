export type ResourceAlertStatus = 'pending' | 'unverified' | 'reclaiming' | 'failed' | 'resolved';
export type ResourceIdentity = { type: string; id: string };
export type ResourceAlert = {
  id: string; cloudWorkspaceId: string; provider: 'alibaba_cloud' | 'tencent_cloud'; accountUid: string;
  regionId: string; type: string; resourceId: string; rangeInstanceId: string | null; rangeName: string | null;
  reason: string; status: ResourceAlertStatus; firstSeenAt: string; lastSeenAt: string;
  evidenceSummary: { recordedInventory: boolean; sourceJobIds: string[]; accountVerified: boolean };
  remainingResources: ResourceIdentity[]; errorSummary: string | null; jobId: string | null;
};
export type ResourceReclaimPreview = {
  alertId: string; cloudWorkspaceId: string; provider: 'alibaba_cloud' | 'tencent_cloud'; accountUid: string;
  regionId: string; rangeInstanceId: string | null; resources: ResourceIdentity[];
  planDigest: string; reclaimable: boolean; reason: string | null;
};
export type ResourcePatrol = {
  managerUserId: string | null; managerUsername: string | null; cloudWorkspaceId: string | null;
  provider: 'alibaba_cloud' | 'tencent_cloud' | null; accountUid: string | null;
  status: 'not_configured' | 'unavailable' | 'failed' | 'ready' | 'pending'; lastScanAt: string | null;
  lastScanError: string | null; regions: string[];
  lastCompleted: { at: string; regions: string[]; succeeded: boolean } | null;
};
export type ResourceReclaimResult = { alertId: string; status: 'reclaiming'; jobId: string };
export type HostCloudReleaseDeadline = {
  provider: 'alibaba_cloud' | 'tencent_cloud'; platformExpiresAt: string; creationPhaseStartedAt: string;
  cloudReleaseAt: string; sourceProvisionJobId: string; status: 'not_configured' | 'unverified' | 'verified';
  verifiedAt?: string; lastCheckedAt?: string; reason?: string; instanceId?: string;
};
