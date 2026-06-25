import { Injectable } from '@nestjs/common';

import {
  RangeProvisionCreateInput,
  RangeProvisionCreateResult,
  RangeProvisionDestroyInput,
  RangeProvisioner,
  type RangeProvisionStepReporter,
} from './provisioning.types';
import { buildEnterpriseProvisionPlan } from './enterprise-provision-plan';

@Injectable()
export class DryRunRangeProvisioner implements RangeProvisioner {
  async create(input: RangeProvisionCreateInput): Promise<RangeProvisionCreateResult> {
    const plan = buildEnterpriseProvisionPlan({
      rangeInstanceId: input.rangeInstanceId,
      templateModulePath: input.templateModulePath,
      topologySpec: input.topologySpec,
      compiledSpec: input.compiledSpec,
      allocatedCidr: input.allocatedCidr,
    });

    await simulateStep(input.reportStep, 'render_template', 'Dry-run rendered enterprise range inputs.');
    await simulateStep(input.reportStep, 'tofu_init', 'Dry-run simulated OpenTofu init.');
    await simulateStep(input.reportStep, 'tofu_plan', 'Dry-run simulated OpenTofu plan.');
    await simulateStep(input.reportStep, 'tofu_apply', 'Dry-run simulated OpenTofu apply.');
    await simulateStep(input.reportStep, 'collect_outputs', 'Dry-run collected simulated outputs.');

    return {
      accessEntry: {
        hostRole: 'dmz',
        publicIp: null,
        privateIp: null,
        url: `https://range.local/${input.rangeInstanceId}`,
        ssh: `ssh root@${input.rangeInstanceId}.range.local`,
      },
      resourceSummary: {
        mode: 'dry-run',
        modulePath: plan.modulePath,
        topologySpec: plan.topologySummary,
      },
    };
  }

  async destroy(_input: RangeProvisionDestroyInput): Promise<void> {
    await simulateStep(_input.reportStep, 'render_template', 'Dry-run rendered destroy inputs.');
    await simulateStep(_input.reportStep, 'tofu_init', 'Dry-run simulated OpenTofu init before destroy.');
    await simulateStep(_input.reportStep, 'destroy', 'Dry-run simulated OpenTofu destroy.');
    return;
  }
}

async function simulateStep(
  reportStep: RangeProvisionStepReporter | undefined,
  stepName: string,
  message: string,
) {
  if (!reportStep) {
    return;
  }

  await reportStep({
    stepName,
    status: 'running',
    message,
  });
  await reportStep({
    stepName,
    status: 'succeeded',
    message,
  });
}
