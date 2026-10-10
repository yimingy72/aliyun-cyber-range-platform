import type {
  ProvisionJobStepStatus,
  RangeAccessEntry,
  RangeRuntimeCredentials,
  SingleInstanceConfig,
  SingleInstanceNetworkProfileRecord,
  RangeTemplateCompiledSpec,
  RangeResourceSummary,
  RangeTemplateTopologySpec,
} from '../admin/admin.repository';
import type { RangeChangeApproval } from './range-update-plan-safety';

export const RANGE_PROVISIONER = Symbol('RANGE_PROVISIONER');

export type RangeProvisionStepEvent = {
  stepName: string;
  status: Exclude<ProvisionJobStepStatus, 'pending'>;
  message?: string | null;
  stdoutExcerpt?: string | null;
  stderrExcerpt?: string | null;
};

export type RangeProvisionStepReporter = (
  event: RangeProvisionStepEvent,
) => Promise<void> | void;

export type ResolvedProvisioningRuntimeConfig = {
  provider?: 'alibaba_cloud' | 'tencent_cloud';
  accountUid?: string | null;
  cloudAccountContextId?: string | null;
  accessKeyId: string;
  accessKeySecret: string;
  defaultRegion: string;
  defaultZoneId: string;
};

export type ProvisioningAttemptedZoneSummary = {
  zoneId: string;
  canCreateAllHosts: boolean;
  estimatedTotalPrice: number | null;
  reason?: string;
};

export type ProvisioningResourceSummary = RangeResourceSummary & {
  selectedZoneId?: string | null;
  attemptedZones?: ProvisioningAttemptedZoneSummary[] | null;
};

export type RangeProvisionCreateInput = {
  knownResourceSummary?: RangeResourceSummary;
  signal?: AbortSignal;
  rangeInstanceId: string;
  expiresAt?: string;
  templateModulePath: string;
  allocatedCidr: string | null;
  preserveWorkspaceState?: boolean;
  requirePersistedState?: boolean;
  onApplyStart?: () => Promise<void>;
  runtimeConfig?: ResolvedProvisioningRuntimeConfig;
  runtimeCredentials?: RangeRuntimeCredentials;
  topologyGraph?: Record<string, unknown> | null;
  topologySpec?: RangeTemplateTopologySpec | null;
  compiledProvisionSpec?: Record<string, unknown> | null;
  compiledSpec?: RangeTemplateCompiledSpec | null;
  reportStep?: RangeProvisionStepReporter;
  instanceMode?: 'range' | 'single';
  singleInstanceConfig?: SingleInstanceConfig | null;
  singleNetworkProfile?: SingleInstanceNetworkProfileRecord | null;
  billingTags?: Record<string, string>;
  changeApproval?: RangeChangeApproval;
};

export type RangeProvisionCreateResult = {
  accessEntry: RangeAccessEntry;
  resourceSummary: ProvisioningResourceSummary;
};

export type RangeProvisionDestroyInput = {
  assertRecoverySourceJob?: (sourceProvisionJobId: string) => Promise<void>;
  knownResourceSummary?: RangeResourceSummary;
  signal?: AbortSignal;
  requirePersistedState?: boolean;
  rangeInstanceId: string;
  expiresAt?: string;
  templateModulePath: string;
  allocatedCidr: string | null;
  runtimeConfig?: ResolvedProvisioningRuntimeConfig;
  runtimeCredentials?: RangeRuntimeCredentials;
  topologyGraph?: Record<string, unknown> | null;
  topologySpec?: RangeTemplateTopologySpec | null;
  compiledProvisionSpec?: Record<string, unknown> | null;
  compiledSpec?: RangeTemplateCompiledSpec | null;
  reportStep?: RangeProvisionStepReporter;
  instanceMode?: 'range' | 'single';
  singleInstanceConfig?: SingleInstanceConfig | null;
  singleNetworkProfile?: SingleInstanceNetworkProfileRecord | null;
  billingTags?: Record<string, string>;
};

export interface RangeProvisioner {
  readonly mode?: 'opentofu' | 'dry-run';
  create(input: RangeProvisionCreateInput): Promise<RangeProvisionCreateResult>;
  destroy(input: RangeProvisionDestroyInput): Promise<void>;
  recoverUntrackedResources?(input: RangeProvisionDestroyInput, assertCurrent: () => Promise<void>, persist: (summary: RangeResourceSummary, sourceProvisionJobId: string) => Promise<void>): Promise<void>;
  inspectResources?(input: RangeProvisionDestroyInput): Promise<RangeResourceSummary | null>;
}
