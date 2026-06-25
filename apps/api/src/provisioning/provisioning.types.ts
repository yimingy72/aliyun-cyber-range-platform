import type {
  ProvisionJobStepStatus,
  RangeAccessEntry,
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

export type RangeProvisionCreateInput = {
  rangeInstanceId: string;
  templateModulePath: string;
  allocatedCidr: string | null;
  topologySpec?: RangeTemplateTopologySpec | null;
  compiledSpec?: RangeTemplateCompiledSpec | null;
  reportStep?: RangeProvisionStepReporter;
};

export type RangeProvisionCreateResult = {
  accessEntry: RangeAccessEntry;
  resourceSummary: RangeResourceSummary;
};

export type RangeProvisionDestroyInput = {
  rangeInstanceId: string;
  templateModulePath: string;
  allocatedCidr: string | null;
  topologySpec?: RangeTemplateTopologySpec | null;
  compiledSpec?: RangeTemplateCompiledSpec | null;
  reportStep?: RangeProvisionStepReporter;
};

export interface RangeProvisioner {
  create(input: RangeProvisionCreateInput): Promise<RangeProvisionCreateResult>;
  destroy(input: RangeProvisionDestroyInput): Promise<void>;
}
