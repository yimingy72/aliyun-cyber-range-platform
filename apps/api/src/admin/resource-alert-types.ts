export type ResourceAlertStatus = 'pending' | 'unverified' | 'reclaiming' | 'failed' | 'resolved';
export type PatrolResourceType = 'ecs' | 'disk' | 'eip' | 'nat_gateway' | 'eni' | 'vpc' | 'vswitch' | 'security_group' | 'network_acl' | 'route_table' | 'snat_entry' | 'dnat_entry';
export type ResourceIdentity = { type: PatrolResourceType; id: string };
export type ResourceAlertView = {
  id: string; cloudWorkspaceId: string; provider: 'alibaba_cloud' | 'tencent_cloud'; accountUid: string;
  regionId: string; type: PatrolResourceType; resourceId: string; rangeInstanceId: string | null; rangeName: string | null;
  reason: string; status: ResourceAlertStatus; firstSeenAt: Date; lastSeenAt: Date;
  evidenceSummary: { recordedInventory: boolean; sourceJobIds: string[]; accountVerified: boolean };
  remainingResources: ResourceIdentity[]; errorSummary: string | null; jobId: string | null;
};
export type ResourceReclaimPreview = {
  alertId: string; cloudWorkspaceId: string; provider: 'alibaba_cloud' | 'tencent_cloud'; accountUid: string; regionId: string;
  rangeInstanceId: string | null; resources: ResourceIdentity[]; planDigest: string; reclaimable: boolean; reason: string | null;
};
export type PatrolSettings = {
  managerUserId: string | null; lastScanAt: Date | null; lastScanError: string | null; regions: string[];
  lastScanWorkspaceId?: string | null;
};
export type StoredResourceAlert = ResourceAlertView & { evidence: Record<string, unknown>; updatedAt: Date };
