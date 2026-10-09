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
  rangeInstanceId: string;
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
};

export type RangeProvisionCreateResult = {
  accessEntry: RangeAccessEntry;
  resourceSummary: ProvisioningResourceSummary;
};

export type RangeProvisionDestroyInput = {
  requirePersistedState?: boolean;
  rangeInstanceId: string;
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
  create(input: RangeProvisionCreateInput): Promise<RangeProvisionCreateResult>;
  destroy(input: RangeProvisionDestroyInput): Promise<void>;
  inspectResources?(input: RangeProvisionDestroyInput): Promise<RangeResourceSummary | null>;
}
