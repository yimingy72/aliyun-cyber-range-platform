import fs from 'node:fs/promises';
import path from 'node:path';
import { createHmac, randomUUID } from 'node:crypto';

import {
  OpenTofuRunner,
  type OpenTofuApplyOptions,
  type OpenTofuDestroyOptions,
  type OpenTofuCommandResult,
  type OpenTofuPlanOptions,
  type OpenTofuValidateOptions,
  type OpenTofuWorkspaceCommandOptions,
} from '@aliyun-cyber-range/iac-runner';

import type {
  RangeRuntimeCredentials,
  RangeTemplateCompiledSpec,
  SingleInstanceConfig,
  SingleInstanceNetworkProfileRecord,
} from '../admin/admin.repository';
import { selectZoneAndHostInstanceTypes } from './aliyun-zone-instance-scheduler';
import { DryRunRangeProvisioner } from './dry-run-range-provisioner';
import { buildEnterpriseProvisionPlan } from './enterprise-provision-plan';
import { resolvePreferredInstanceTypes } from './instance-type-catalog';
import { AlibabaCloudOpenTofuRenderer } from './renderers/alibaba-cloud-opentofu-renderer';
import { buildRootWrapperFiles } from './root-wrapper-template';
import { buildSingleInstanceRootWrapperFiles } from './single-instance-root-wrapper-template';
import {
  type ProvisioningAttemptedZoneSummary,
  type RangeProvisionCreateInput,
  type RangeProvisionCreateResult,
  type RangeProvisionDestroyInput,
  type RangeProvisioner,
  type ResolvedProvisioningRuntimeConfig,
  type RangeProvisionStepReporter,
} from './provisioning.types';

type OpenTofuProvisionerEnv = Partial<
  Pick<
    NodeJS.ProcessEnv,
    | 'ALICLOUD_ACCESS_KEY'
    | 'ALICLOUD_SECRET_KEY'
    | 'ALICLOUD_REGION'
    | 'ALICLOUD_ZONE_ID'
    | 'ALICLOUD_IMAGE_ID'
    | 'ALICLOUD_IMAGE_ID_PREFERENCES'
    | 'ALICLOUD_INSTANCE_TYPE'
    | 'ALICLOUD_INSTANCE_TYPE_PREFERENCES'
    | 'ALICLOUD_PROVIDER_ZIP_PATH'
    | 'RANGE_PROVISIONER_MODE'
    | 'OPENTOFU_BINARY'
    | 'OPENTOFU_WORKSPACES_ROOT'
    | 'PATH'
    | 'TF_CLI_CONFIG_FILE'
    | 'OPENTOFU_INSTANCE_TYPE'
    | 'OPENTOFU_INSTANCE_TYPE_PREFERENCES'
    | 'OPENTOFU_IMAGE_ID'
    | 'OPENTOFU_IMAGE_ID_PREFERENCES'
    | 'OPENTOFU_ALLOWED_INGRESS_CIDR'
    | 'OPENTOFU_SYSTEM_DISK_CATEGORY'
    | 'OPENTOFU_SYSTEM_DISK_SIZE'
    | 'OPENTOFU_INTERNET_MAX_BANDWIDTH_OUT'
    | 'OPENTOFU_PASSTHROUGH_PROXY'
    | 'HTTPS_PROXY'
    | 'HTTP_PROXY'
    | 'ALL_PROXY'
    | 'https_proxy'
    | 'http_proxy'
    | 'all_proxy'
    | 'NO_PROXY'
    | 'no_proxy'
  >
>;

type OpenTofuOutputValue<T> = {
  value: T;
};

type OpenTofuOutputs = {
  public_entry?: OpenTofuOutputValue<{
    host_role?: string;
    public_ip?: string;
    private_ip?: string;
    ssh?: string;
    url?: string;
  }>;
  resource_summary?: OpenTofuOutputValue<{
    vpc_id?: string;
    subnet_ids?: Record<string, string>;
    host_ids?: Record<string, string>;
    secondary_network_interface_ids?: Record<string, string>;
    nat_gateway_ids?: Record<string, string>;
    snat_entry_ids?: Record<string, string>;
    dnat_entry_ids?: Record<string, string>;
    eip_allocation_id?: string;
    eip_allocation_ids?: Record<string, string>;
    bootstrap_host_keys?: string[];
    runtime_selections?: Record<string, unknown>;
    selected_zone_id?: string;
    attempted_zones?: Array<{
      zone_id?: string;
      can_create_all_hosts?: boolean;
      estimated_total_price?: number | null;
      reason?: string;
    }>;
    resolved_instance_type?: string;
    resolved_image_id?: string;
  }>;
};

type OpenTofuRunnerLike = {
  init(options: OpenTofuWorkspaceCommandOptions): Promise<OpenTofuCommandResult>;
  validate(options: OpenTofuValidateOptions): Promise<OpenTofuCommandResult>;
  plan(options: OpenTofuPlanOptions): Promise<OpenTofuCommandResult>;
  apply(options: OpenTofuApplyOptions): Promise<OpenTofuCommandResult>;
  output<T>(options: OpenTofuWorkspaceCommandOptions): Promise<T>;
  destroy(options: OpenTofuDestroyOptions): Promise<OpenTofuCommandResult>;
};

type OpenTofuRangeProvisionerOptions = {
  runner?: OpenTofuRunnerLike;
  projectRootDir?: string;
  workspacesRootDir?: string;
  env?: OpenTofuProvisionerEnv;
  enableZoneScheduling?: boolean;
  availableInstanceTypeResolver?: AvailableInstanceTypeResolver;
  availableImageIdResolver?: AvailableImageIdResolver;
};

type CreateRangeProvisionerFromEnvOptions = OpenTofuRangeProvisionerOptions;

type PreparedWorkspace = {
  workspaceDir: string;
  planFilePath: string;
  outputsFilePath: string;
  varsFilePath: string;
  runnerEnv: NodeJS.ProcessEnv;
};

type AvailableInstanceTypeResolverInput = {
  accessKey: string;
  secretKey: string;
  regionId: string;
  zoneId: string;
  systemDiskCategory?: string;
  preferredInstanceTypes: string[];
  strictPreferredInstanceTypes?: boolean;
};

type AvailableInstanceTypeResolver = (
  input: AvailableInstanceTypeResolverInput,
) => Promise<string>;

type AvailableImageIdResolverInput = {
  accessKey: string;
  secretKey: string;
  regionId: string;
  requestedImageId?: string;
  preferredImageIds: string[];
};

type AvailableImageIdResolver = (input: AvailableImageIdResolverInput) => Promise<string>;

type HostInstanceResolutionHint = {
  instanceTypePolicyKey?: string;
  requestedCpu?: number;
  requestedMemoryGiB?: number;
  finalInstanceType?: string;
  finalImageId?: string;
  instanceTypeStrategy?: {
    mode?: string;
    instanceType?: string;
    preferredInstanceTypes: string[];
  };
};

const DEFAULT_WORKSPACES_ROOT = '.local/opentofu-workspaces';
const PROVIDER_MIRROR_REGISTRY_PATH = path.join(
  'registry.opentofu.org',
  'aliyun',
  'alicloud',
);
const DEFAULT_AUTO_INSTANCE_TYPE_PREFERENCES = [
  'ecs.u1-c1m2.large',
  'ecs.e-c1m2.large',
  'ecs.t6-c1m2.large',
  'ecs.c6t.large',
  'ecs.hfc6.large',
  'ecs.sn1ne.large',
  'ecs.sn1.medium',
  'ecs.n1.medium',
  'ecs.c7.large',
  'ecs.g7.large',
  'ecs.c6.large',
  'ecs.g6.large',
];
const DEFAULT_AUTO_IMAGE_ID_PREFERENCES = [
  'ubuntu_24_04_x64_20G_alibase_20260615.vhd',
  'ubuntu_22_04_x64_20G_alibase_20260615.vhd',
  'debian_12_14_x64_20G_alibase_20260609.vhd',
  'centos_stream_9_x64_20G_alibase_20260616.vhd',
];
const PROXY_ENV_KEYS = [
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'ALL_PROXY',
  'https_proxy',
  'http_proxy',
  'all_proxy',
  'NO_PROXY',
  'no_proxy',
] as const;
const RUNNER_ENV_KEYS = ['PATH', 'TF_CLI_CONFIG_FILE'] as const;
const ALICLOUD_RPC_FORMAT = 'JSON';
const ALICLOUD_RPC_SIGNATURE_METHOD = 'HMAC-SHA1';
const ALICLOUD_RPC_SIGNATURE_VERSION = '1.0';
const ALICLOUD_RPC_API_VERSION = '2014-05-26';

export function createRangeProvisionerFromEnv(
  options: CreateRangeProvisionerFromEnvOptions = {},
): RangeProvisioner {
  const env = options.env ?? process.env;
  const mode = env.RANGE_PROVISIONER_MODE ?? 'opentofu';

  if (mode === 'dry-run') {
    return new DryRunRangeProvisioner();
  }

  if (mode === 'opentofu') {
    return new OpenTofuRangeProvisioner(options);
  }

  throw new Error(`Unsupported RANGE_PROVISIONER_MODE: ${mode}`);
}

export class OpenTofuRangeProvisioner implements RangeProvisioner {
  private readonly runner: OpenTofuRunnerLike;
  private readonly projectRootDir: string;
  private readonly workspacesRootDir: string;
  private readonly env: OpenTofuProvisionerEnv;
  private readonly enableZoneScheduling: boolean;
  private readonly availableInstanceTypeResolver: AvailableInstanceTypeResolver;
  private readonly availableImageIdResolver: AvailableImageIdResolver;
  private readonly renderer: AlibabaCloudOpenTofuRenderer;

  constructor(options: OpenTofuRangeProvisionerOptions = {}) {
    this.env = {
      ...process.env,
      ...options.env,
    };
    this.projectRootDir = options.projectRootDir ?? process.cwd();
    this.workspacesRootDir = resolveWorkspaceRootDir({
      projectRootDir: this.projectRootDir,
      workspacesRootDir: options.workspacesRootDir,
      env: this.env,
    });
    this.enableZoneScheduling = options.enableZoneScheduling ?? true;
    this.runner =
      options.runner ??
      new OpenTofuRunner({
        binaryPath: this.env.OPENTOFU_BINARY || 'tofu',
      });
    this.availableInstanceTypeResolver =
      options.availableInstanceTypeResolver ?? resolveAvailableAliyunInstanceType;
    this.availableImageIdResolver =
      options.availableImageIdResolver ?? resolveAvailableAliyunImageId;
    this.renderer = new AlibabaCloudOpenTofuRenderer();
  }

  async renderSingleInstanceWorkspace(input: {
    rangeInstanceId: string;
    runtimeCredentials?: RangeRuntimeCredentials;
    singleInstanceConfig: SingleInstanceConfig;
    singleNetworkProfile: SingleInstanceNetworkProfileRecord;
    billingTags?: Record<string, string>;
  }) {
    return {
      files: await this.buildSingleInstanceWorkspaceFiles({
        moduleSource: 'infra/opentofu/modules/alicloud-vpc-single-ecs',
        ...input,
      }),
    };
  }

  async create(input: RangeProvisionCreateInput): Promise<RangeProvisionCreateResult> {
    const plan =
      input.instanceMode === 'single'
        ? null
        : buildEnterpriseProvisionPlan({
            rangeInstanceId: input.rangeInstanceId,
            templateModulePath: input.templateModulePath,
            topologySpec: input.topologySpec,
            compiledProvisionSpec: input.compiledProvisionSpec,
            compiledSpec: input.compiledSpec,
            allocatedCidr: input.allocatedCidr,
          });

    const workspace = await runProvisionStep(input.reportStep, 'render_template', async () => {
      const preparedWorkspace = await this.prepareWorkspace(input, {
        preserveWorkspaceState: input.preserveWorkspaceState === true,
      });

      return {
        result: preparedWorkspace,
        message: `Rendered OpenTofu workspace at ${preparedWorkspace.workspaceDir}`,
      };
    });

    await runProvisionStep(input.reportStep, 'tofu_init', async () => {
      const command = await this.runner.init({
        workspaceDir: workspace.workspaceDir,
        env: workspace.runnerEnv,
      });

      return {
        result: command,
        message: 'OpenTofu init completed.',
        stdoutExcerpt: command.stdout,
        stderrExcerpt: command.stderr,
      };
    });
    await runProvisionStep(input.reportStep, 'tofu_validate', async () => {
      const command = await this.runner.validate({
        workspaceDir: workspace.workspaceDir,
        env: workspace.runnerEnv,
        varsFilePath: workspace.varsFilePath,
      });

      return {
        result: command,
        message: 'OpenTofu validate completed.',
        stdoutExcerpt: command.stdout,
        stderrExcerpt: command.stderr,
      };
    });
    await runProvisionStep(input.reportStep, 'tofu_plan', async () => {
      const command = await this.runner.plan({
        workspaceDir: workspace.workspaceDir,
        env: workspace.runnerEnv,
        planFilePath: workspace.planFilePath,
        varsFilePath: workspace.varsFilePath,
      });

      return {
        result: command,
        message: 'OpenTofu plan completed.',
        stdoutExcerpt: command.stdout,
        stderrExcerpt: command.stderr,
      };
    });
    await runProvisionStep(input.reportStep, 'tofu_apply', async () => {
      const command = await this.runner.apply({
        workspaceDir: workspace.workspaceDir,
        env: workspace.runnerEnv,
        planFilePath: workspace.planFilePath,
      });

      return {
        result: command,
        message: 'OpenTofu apply completed.',
        stdoutExcerpt: command.stdout,
        stderrExcerpt: command.stderr,
      };
    });

    const outputs = await runProvisionStep(input.reportStep, 'collect_outputs', async () => {
      const collectedOutputs = await this.runner.output<OpenTofuOutputs>({
        workspaceDir: workspace.workspaceDir,
        env: workspace.runnerEnv,
      });

      const collectedResourceSummary = readOutputValue(collectedOutputs.resource_summary);
      const collectOutputTags = [
        collectedResourceSummary?.resolved_instance_type
          ? `instanceType=${collectedResourceSummary.resolved_instance_type}`
          : null,
        collectedResourceSummary?.resolved_image_id ? `imageId=${collectedResourceSummary.resolved_image_id}` : null,
        collectedResourceSummary?.snat_entry_ids
          ? `snat=${Object.keys(collectedResourceSummary.snat_entry_ids).join(',')}`
          : null,
        collectedResourceSummary?.dnat_entry_ids
          ? `dnat=${Object.keys(collectedResourceSummary.dnat_entry_ids).join(',')}`
          : null,
      ].filter((value): value is string => Boolean(value));

      await fs.writeFile(
        workspace.outputsFilePath,
        `${JSON.stringify(collectedOutputs, null, 2)}\n`,
        'utf8',
      );

      return {
        result: collectedOutputs,
        message: `Collected OpenTofu outputs into ${workspace.outputsFilePath}${collectOutputTags.length > 0 ? ` (${collectOutputTags.join(' | ')})` : ''}`,
      };
    });

    const publicEntry = readOutputValue(outputs.public_entry);
    const resourceSummary = readOutputValue(outputs.resource_summary);

    return {
      accessEntry: {
        hostRole: publicEntry?.host_role ?? 'dmz',
        publicIp: publicEntry?.public_ip ?? null,
        privateIp: publicEntry?.private_ip ?? null,
        ssh: publicEntry?.ssh ?? null,
        ...(publicEntry?.url ? { url: publicEntry.url } : {}),
      },
      resourceSummary: {
        mode: 'opentofu',
        workspaceDir: workspace.workspaceDir,
        outputFilePath: workspace.outputsFilePath,
        vpcId: resourceSummary?.vpc_id ?? null,
        subnetIds: resourceSummary?.subnet_ids ?? null,
        hostIds: resourceSummary?.host_ids ?? null,
        secondaryNetworkInterfaceIds: resourceSummary?.secondary_network_interface_ids ?? null,
        natGatewayIds: resourceSummary?.nat_gateway_ids ?? null,
        snatEntryIds: resourceSummary?.snat_entry_ids ?? null,
        dnatEntryIds: resourceSummary?.dnat_entry_ids ?? null,
        eipAllocationId: resourceSummary?.eip_allocation_id ?? null,
        eipAllocationIds: resourceSummary?.eip_allocation_ids ?? null,
        bootstrapHostKeys: resourceSummary?.bootstrap_host_keys ?? null,
        runtimeSelections: resourceSummary?.runtime_selections ?? null,
        selectedZoneId: resourceSummary?.selected_zone_id ?? null,
        attemptedZones: resourceSummary?.attempted_zones?.map((zone) => ({
          zoneId: zone.zone_id ?? '',
          canCreateAllHosts: zone.can_create_all_hosts ?? false,
          estimatedTotalPrice: zone.estimated_total_price ?? null,
          ...(zone.reason ? { reason: zone.reason } : {}),
        })) ?? null,
        resolvedInstanceType: resourceSummary?.resolved_instance_type ?? null,
        resolvedImageId: resourceSummary?.resolved_image_id ?? null,
        ...(plan ? { topologySpec: plan.topologySummary } : {}),
      },
    };
  }

  async destroy(input: RangeProvisionDestroyInput): Promise<void> {
    const workspace = await runProvisionStep(input.reportStep, 'render_template', async () => {
      const preparedWorkspace = await this.prepareWorkspace(input, {
        preserveWorkspaceState: true,
      });

      return {
        result: preparedWorkspace,
        message: `Rendered destroy workspace at ${preparedWorkspace.workspaceDir}`,
      };
    });

    await runProvisionStep(input.reportStep, 'tofu_init', async () => {
      const command = await this.runner.init({
        workspaceDir: workspace.workspaceDir,
        env: workspace.runnerEnv,
      });

      return {
        result: command,
        message: 'OpenTofu init completed before destroy.',
        stdoutExcerpt: command.stdout,
        stderrExcerpt: command.stderr,
      };
    });
    await runProvisionStep(input.reportStep, 'tofu_validate', async () => {
      const command = await this.runner.validate({
        workspaceDir: workspace.workspaceDir,
        env: workspace.runnerEnv,
        varsFilePath: workspace.varsFilePath,
      });

      return {
        result: command,
        message: 'OpenTofu validate completed before destroy.',
        stdoutExcerpt: command.stdout,
        stderrExcerpt: command.stderr,
      };
    });
    await runProvisionStep(input.reportStep, 'destroy', async () => {
      const command = await this.runner.destroy({
        workspaceDir: workspace.workspaceDir,
        env: workspace.runnerEnv,
        varsFilePath: workspace.varsFilePath,
      });

      return {
        result: command,
        message: 'OpenTofu destroy completed.',
        stdoutExcerpt: command.stdout,
        stderrExcerpt: command.stderr,
      };
    });
  }

  private async prepareWorkspace(
    input: RangeProvisionCreateInput | RangeProvisionDestroyInput,
    options: {
      preserveWorkspaceState: boolean;
    },
  ): Promise<PreparedWorkspace> {
    if (input.instanceMode === 'single') {
      return this.prepareSingleInstanceWorkspace(input, options);
    }

    const moduleDir = path.resolve(this.projectRootDir, input.templateModulePath);
    const workspaceDir = path.join(this.workspacesRootDir, input.rangeInstanceId);
    const planFilePath = path.join(workspaceDir, 'range.tfplan');
    const outputsFilePath = path.join(workspaceDir, 'outputs.json');
    const varsFilePath = path.join(workspaceDir, 'range.auto.tfvars.json');

    await assertDirectoryExists(moduleDir, 'OpenTofu module path does not exist');
    if (!options.preserveWorkspaceState) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
    await fs.mkdir(workspaceDir, { recursive: true });

    const wrapperFiles = buildRootWrapperFiles(moduleDir);

    await Promise.all(
      Object.entries(wrapperFiles).map(async ([fileName, contents]) => {
        await fs.writeFile(path.join(workspaceDir, fileName), contents, 'utf8');
      }),
    );

    const variables = await this.buildVariables(input);
    await fs.writeFile(varsFilePath, `${JSON.stringify(variables, null, 2)}\n`, 'utf8');

    const runnerEnv = await this.buildRunnerEnv(input.runtimeConfig);

    return {
      workspaceDir,
      planFilePath,
      outputsFilePath,
      varsFilePath,
      runnerEnv,
    };
  }

  private async prepareSingleInstanceWorkspace(
    input: RangeProvisionCreateInput | RangeProvisionDestroyInput,
    options: {
      preserveWorkspaceState: boolean;
    },
  ): Promise<PreparedWorkspace> {
    const singleInstanceConfig = input.singleInstanceConfig;
    const singleNetworkProfile = input.singleNetworkProfile;

    if (!singleInstanceConfig) {
      throw new Error('Single instance config missing');
    }

    if (!singleNetworkProfile) {
      throw new Error('Single instance network profile missing');
    }

    const moduleDir = path.resolve(this.projectRootDir, input.templateModulePath);
    const workspaceDir = path.join(this.workspacesRootDir, input.rangeInstanceId);
    const planFilePath = path.join(workspaceDir, 'single-instance.tfplan');
    const outputsFilePath = path.join(workspaceDir, 'outputs.json');
    const varsFilePath = path.join(workspaceDir, 'terraform.tfvars.json');

    await assertDirectoryExists(moduleDir, 'OpenTofu module path does not exist');
    if (!options.preserveWorkspaceState) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
    await fs.mkdir(workspaceDir, { recursive: true });

    const files = await this.buildSingleInstanceWorkspaceFiles({
      moduleSource: moduleDir,
      rangeInstanceId: input.rangeInstanceId,
      runtimeConfig: input.runtimeConfig,
      runtimeCredentials: input.runtimeCredentials,
      singleInstanceConfig,
      singleNetworkProfile,
    });

    await Promise.all(
      Object.entries(files).map(async ([fileName, contents]) => {
        await fs.writeFile(path.join(workspaceDir, fileName), contents, 'utf8');
      }),
    );

    return {
      workspaceDir,
      planFilePath,
      outputsFilePath,
      varsFilePath,
      runnerEnv: await this.buildRunnerEnv(input.runtimeConfig),
    };
  }

  private async buildVariables(input: RangeProvisionCreateInput | RangeProvisionDestroyInput) {
    const plan = buildEnterpriseProvisionPlan({
      rangeInstanceId: input.rangeInstanceId,
      templateModulePath: input.templateModulePath,
      topologySpec: input.topologySpec,
      compiledProvisionSpec: input.compiledProvisionSpec,
      compiledSpec: input.compiledSpec,
      allocatedCidr: input.allocatedCidr,
    });
    const runtimeConfig = this.resolveRuntimeConfig(input.runtimeConfig);
    const hostProvisioningHints = buildHostInstanceResolutionHints(
      input.compiledProvisionSpec,
      input.compiledSpec,
    );
    let zoneId = runtimeConfig.defaultZoneId;
    let attemptedZones: ProvisioningAttemptedZoneSummary[] = [];
    let hostInstanceTypes: Record<string, string>;
    const requestedInstanceType = normalizeOptionalEnvValue(
      this.env.OPENTOFU_INSTANCE_TYPE ?? this.env.ALICLOUD_INSTANCE_TYPE,
    );
    const systemDiskCategory = this.readSystemDiskCategory();
    const hostInstanceTypeRequests = this.buildHostInstanceTypeRequests({
      plan,
      hostProvisioningHints,
    });
    const requiresMultiNicCapacityScheduling = hostInstanceTypeRequests.some(
      (host) => (host.networkInterfaceCount ?? 1) > 2,
    );

    if (
      requiresMultiNicCapacityScheduling ||
      (this.enableZoneScheduling &&
        (!requestedInstanceType || requestedInstanceType.toLowerCase() === 'auto'))
    ) {
      const zoneSelection = await selectZoneAndHostInstanceTypes({
        regionId: runtimeConfig.defaultRegion,
        defaultZoneId: runtimeConfig.defaultZoneId,
        ...(systemDiskCategory ? { systemDiskCategory } : {}),
        hostRequests: hostInstanceTypeRequests,
        account: {
          accessKeyId: runtimeConfig.accessKeyId,
          accessKeySecret: runtimeConfig.accessKeySecret,
        },
      });
      zoneId = zoneSelection.selectedZoneId;
      attemptedZones = zoneSelection.attemptedZones;
      hostInstanceTypes = zoneSelection.hostInstanceTypes;
    } else {
      hostInstanceTypes = await this.resolveHostInstanceTypes({
        plan,
        hostProvisioningHints,
        runtimeConfig,
      });
    }

    const preferredHostInstanceType =
      hostInstanceTypes[plan.entryHostKey] ?? hostInstanceTypes[plan.hostDefinitions[0]?.key ?? ''];
    const instanceType = preferredHostInstanceType
      ? preferredHostInstanceType
      : await this.resolveInstanceType(runtimeConfig);
    const hostImageIds = resolveFinalHostImageIds({
      hostProvisioningHints,
      hostKeys: plan.hostDefinitions.map((host) => host.key),
      preferredHostKey: plan.entryHostKey,
    });
    const finalHostImageId = resolveGlobalHostImageId(hostImageIds);
    const imageId = finalHostImageId
      ? finalHostImageId
      : await this.resolveImageId(runtimeConfig);
    const hostPasswords = Object.fromEntries(
      plan.hostDefinitions.map((host) => [
        host.key,
        requireRuntimePassword(input.runtimeCredentials, host.key),
      ]),
    );
    const instancePassword = requireRuntimePassword(input.runtimeCredentials, plan.entryHostKey);
    return this.renderer.render({
      plan,
      rangeInstanceId: input.rangeInstanceId,
      zoneId,
      attemptedZones,
      instanceType,
      hostInstanceTypes,
      imageId,
      hostImageIds,
      hostPasswords,
      instancePassword,
      tags: {
        range_instance_id: input.rangeInstanceId,
        ...(input.billingTags ?? {}),
      },
      allowedIngressCidr: this.env.OPENTOFU_ALLOWED_INGRESS_CIDR ?? '0.0.0.0/0',
      ...(this.env.OPENTOFU_INTERNET_MAX_BANDWIDTH_OUT
        ? {
            internetMaxBandwidthOut: Number(this.env.OPENTOFU_INTERNET_MAX_BANDWIDTH_OUT),
          }
        : {}),
      ...(systemDiskCategory
        ? {
            systemDiskCategory,
          }
        : {}),
      ...(this.env.OPENTOFU_SYSTEM_DISK_SIZE
        ? {
            systemDiskSize: Number(this.env.OPENTOFU_SYSTEM_DISK_SIZE),
          }
        : {}),
    });
  }

  private async buildSingleInstanceWorkspaceFiles(input: {
    moduleSource: string;
    rangeInstanceId: string;
    runtimeConfig?: ResolvedProvisioningRuntimeConfig;
    runtimeCredentials?: RangeRuntimeCredentials;
    singleInstanceConfig: SingleInstanceConfig;
    singleNetworkProfile: SingleInstanceNetworkProfileRecord;
    billingTags?: Record<string, string>;
  }) {
    const assignedVswitchId =
      input.singleInstanceConfig.assignedVswitchId?.trim() || input.singleNetworkProfile.vswitchIds[0];
    const assignedVswitchIndex = input.singleNetworkProfile.vswitchIds.indexOf(assignedVswitchId);

    if (assignedVswitchIndex < 0) {
      throw new Error(`Assigned single-instance vSwitch not found in persisted profile: ${assignedVswitchId}`);
    }

    const instancePassword = requireRuntimePassword(
      input.runtimeCredentials,
      input.singleInstanceConfig.hostKey,
    );
    const requestedInstanceType = normalizeOptionalEnvValue(
      this.env.OPENTOFU_INSTANCE_TYPE ?? this.env.ALICLOUD_INSTANCE_TYPE,
    );
    const preferredInstanceTypes = resolvePreferredInstanceTypes(
      input.singleInstanceConfig.cpu,
      input.singleInstanceConfig.memory,
    );
    const singleRuntimeConfig = input.runtimeConfig
      ? this.resolveRuntimeConfig(input.runtimeConfig)
      : this.resolveRuntimeConfig({
          accessKeyId: this.env.ALICLOUD_ACCESS_KEY ?? '',
          accessKeySecret: this.env.ALICLOUD_SECRET_KEY ?? '',
          defaultRegion: input.singleNetworkProfile.regionId,
          defaultZoneId: input.singleNetworkProfile.zoneId,
        });
    const instanceType =
      requestedInstanceType && requestedInstanceType.toLowerCase() !== 'auto'
        ? requestedInstanceType
        : await this.resolveInstanceType(singleRuntimeConfig, preferredInstanceTypes);
    const systemDiskCategory = this.readSystemDiskCategory();

    return {
      ...buildSingleInstanceRootWrapperFiles(input.moduleSource),
      'terraform.tfvars.json': JSON.stringify({
        resource_name_prefix: input.rangeInstanceId,
        instance_name: buildSingleInstanceName(input.singleInstanceConfig),
        host_name: input.singleInstanceConfig.hostName,
        host_key: input.singleInstanceConfig.hostKey,
        zone_id: input.singleNetworkProfile.zoneId,
        vpc_cidr: input.singleNetworkProfile.vpcCidr,
        vswitch_cidr: input.singleNetworkProfile.vswitchCidrs[assignedVswitchIndex],
        existing_vpc_id: input.singleNetworkProfile.vpcId,
        existing_vswitch_id: assignedVswitchId,
        existing_security_group_id: input.singleNetworkProfile.securityGroupId,
        image_id: input.singleInstanceConfig.imageId,
        instance_type: instanceType,
        instance_password: instancePassword,
        ...(this.env.OPENTOFU_ALLOWED_INGRESS_CIDR
          ? {
              allowed_ingress_cidr: this.env.OPENTOFU_ALLOWED_INGRESS_CIDR,
            }
          : {}),
        ...(this.env.OPENTOFU_INTERNET_MAX_BANDWIDTH_OUT
          ? {
              internet_max_bandwidth_out: Number(this.env.OPENTOFU_INTERNET_MAX_BANDWIDTH_OUT),
            }
          : {}),
        ...(systemDiskCategory
          ? {
              system_disk_category: systemDiskCategory,
            }
          : {}),
        system_disk_size: input.singleInstanceConfig.systemDiskSize,
        tags: {
          instance_mode: 'single',
          host_key: input.singleInstanceConfig.hostKey,
          base_name: input.singleInstanceConfig.baseName,
          ...(input.billingTags ?? {}),
        },
      }),
    };
  }

  private async resolveInstanceType(
    runtimeConfig: ResolvedProvisioningRuntimeConfig,
    preferredInstanceTypes?: readonly string[],
  ) {
    const requestedInstanceType = normalizeOptionalEnvValue(
      this.env.OPENTOFU_INSTANCE_TYPE ?? this.env.ALICLOUD_INSTANCE_TYPE,
    );

    if (requestedInstanceType && requestedInstanceType.toLowerCase() !== 'auto') {
      return requestedInstanceType;
    }
    const systemDiskCategory = this.readSystemDiskCategory();

    return this.availableInstanceTypeResolver({
      accessKey: runtimeConfig.accessKeyId,
      secretKey: runtimeConfig.accessKeySecret,
      regionId: runtimeConfig.defaultRegion,
      zoneId: runtimeConfig.defaultZoneId,
      ...(systemDiskCategory ? { systemDiskCategory } : {}),
      preferredInstanceTypes:
        preferredInstanceTypes && preferredInstanceTypes.length > 0
          ? [...preferredInstanceTypes]
          : readInstanceTypePreferences(this.env),
    });
  }

  private async resolveHostInstanceTypes(input: {
    plan: ReturnType<typeof buildEnterpriseProvisionPlan>;
    hostProvisioningHints: Map<string, HostInstanceResolutionHint>;
    runtimeConfig: ResolvedProvisioningRuntimeConfig;
  }) {
    const requestedInstanceType = normalizeOptionalEnvValue(
      this.env.OPENTOFU_INSTANCE_TYPE ?? this.env.ALICLOUD_INSTANCE_TYPE,
    );

    if (requestedInstanceType && requestedInstanceType.toLowerCase() !== 'auto') {
      return Object.fromEntries(
        input.plan.hostDefinitions.map((host) => [host.key, requestedInstanceType]),
      );
    }

    const systemDiskCategory = this.readSystemDiskCategory();
    const defaultPreferences = readInstanceTypePreferences(this.env);
    const resolutionCache = new Map<string, Promise<string>>();
    const resolvedHostInstanceTypes: Record<string, string> = {};

    for (const host of input.plan.hostDefinitions) {
      const resolutionPolicy = resolveHostInstanceTypePolicy({
        runtimeSelections: input.plan.runtimeSelections.instanceTypePolicies,
        runtimeHint: input.hostProvisioningHints.get(host.key),
      });
      if (resolutionPolicy.fixedInstanceType) {
        resolvedHostInstanceTypes[host.key] = resolutionPolicy.fixedInstanceType;
        continue;
      }

      const preferredInstanceTypes =
        resolutionPolicy.preferredInstanceTypes.length > 0
          ? resolutionPolicy.preferredInstanceTypes
          : defaultPreferences;
      const cacheKey = `${resolutionPolicy.strictPreferredInstanceTypes ? 'strict' : 'loose'}:${preferredInstanceTypes.join(',')}`;

      let resolutionPromise = resolutionCache.get(cacheKey);
      if (!resolutionPromise) {
        resolutionPromise = this.availableInstanceTypeResolver({
          accessKey: input.runtimeConfig.accessKeyId,
          secretKey: input.runtimeConfig.accessKeySecret,
          regionId: input.runtimeConfig.defaultRegion,
          zoneId: input.runtimeConfig.defaultZoneId,
          ...(systemDiskCategory ? { systemDiskCategory } : {}),
          preferredInstanceTypes,
          ...(resolutionPolicy.strictPreferredInstanceTypes
            ? { strictPreferredInstanceTypes: true }
            : {}),
        });
        resolutionCache.set(cacheKey, resolutionPromise);
      }

      resolvedHostInstanceTypes[host.key] = await resolutionPromise;
    }

    return resolvedHostInstanceTypes;
  }

  private buildHostInstanceTypeRequests(input: {
    plan: ReturnType<typeof buildEnterpriseProvisionPlan>;
    hostProvisioningHints: Map<string, HostInstanceResolutionHint>;
  }) {
    const requestedInstanceType = normalizeOptionalEnvValue(
      this.env.OPENTOFU_INSTANCE_TYPE ?? this.env.ALICLOUD_INSTANCE_TYPE,
    );
    const defaultPreferences = readInstanceTypePreferences(this.env);
    const networkInterfaceCountByHost = new Map(
      input.plan.hostNetworkInterfaces.map((hostNetworkInterfaces) => [
        hostNetworkInterfaces.hostKey,
        Math.max(1, hostNetworkInterfaces.interfaces.length),
      ]),
    );

    return input.plan.hostDefinitions.map((host) => {
      const runtimeHint = input.hostProvisioningHints.get(host.key);
      const networkInterfaceCount = networkInterfaceCountByHost.get(host.key) ?? 1;

      if (requestedInstanceType && requestedInstanceType.toLowerCase() !== 'auto') {
        return {
          hostKey: host.key,
          ...(typeof runtimeHint?.requestedCpu === 'number' ? { cpu: runtimeHint.requestedCpu } : {}),
          ...(typeof runtimeHint?.requestedMemoryGiB === 'number'
            ? { memoryGiB: runtimeHint.requestedMemoryGiB }
            : {}),
          networkInterfaceCount,
          preferredInstanceTypes: [requestedInstanceType],
          strictPreferredInstanceTypes: true,
        };
      }

      const resolutionPolicy = resolveHostInstanceTypePolicy({
        runtimeSelections: input.plan.runtimeSelections.instanceTypePolicies,
        runtimeHint,
      });

      return {
        hostKey: host.key,
        ...(typeof runtimeHint?.requestedCpu === 'number' ? { cpu: runtimeHint.requestedCpu } : {}),
        ...(typeof runtimeHint?.requestedMemoryGiB === 'number'
          ? { memoryGiB: runtimeHint.requestedMemoryGiB }
          : {}),
        networkInterfaceCount,
        ...(resolutionPolicy.strictPreferredInstanceTypes
          ? { strictPreferredInstanceTypes: true }
          : {}),
        preferredInstanceTypes: resolutionPolicy.fixedInstanceType
          ? [resolutionPolicy.fixedInstanceType]
          : resolutionPolicy.preferredInstanceTypes.length > 0
            ? resolutionPolicy.preferredInstanceTypes
            : [...defaultPreferences],
      };
    });
  }

  private async resolveImageId(runtimeConfig: ResolvedProvisioningRuntimeConfig) {
    const requestedImageId = normalizeOptionalEnvValue(
      this.env.OPENTOFU_IMAGE_ID ?? this.env.ALICLOUD_IMAGE_ID,
    );

    if (requestedImageId && requestedImageId.toLowerCase() !== 'auto') {
      return requestedImageId;
    }

    return this.availableImageIdResolver({
      accessKey: runtimeConfig.accessKeyId,
      secretKey: runtimeConfig.accessKeySecret,
      regionId: runtimeConfig.defaultRegion,
      ...(requestedImageId && requestedImageId.toLowerCase() !== 'auto'
        ? { requestedImageId }
        : {}),
      preferredImageIds: readImageIdPreferences(this.env),
    });
  }

  private async buildRunnerEnv(
    runtimeConfig: ResolvedProvisioningRuntimeConfig = this.resolveRuntimeConfig(),
  ): Promise<NodeJS.ProcessEnv> {
    const providerZipPath = this.env.ALICLOUD_PROVIDER_ZIP_PATH?.trim();

    const runnerEnv: NodeJS.ProcessEnv = {
      // ponytail: keep the runner env tiny; add keys here only for a concrete child-process need.
      ...pickEnv(process.env, RUNNER_ENV_KEYS),
      ...pickEnv(this.env, RUNNER_ENV_KEYS),
      ALICLOUD_ACCESS_KEY: runtimeConfig.accessKeyId,
      ALICLOUD_SECRET_KEY: runtimeConfig.accessKeySecret,
      ALICLOUD_REGION: runtimeConfig.defaultRegion,
    };

    if (normalizeOptionalEnvValue(this.env.OPENTOFU_PASSTHROUGH_PROXY) === '1') {
      Object.assign(runnerEnv, pickEnv(process.env, PROXY_ENV_KEYS), pickEnv(this.env, PROXY_ENV_KEYS));
    }

    if (!providerZipPath) {
      return runnerEnv;
    }

    await assertFileExists(providerZipPath, 'ALICLOUD provider zip does not exist');

    const providerMirrorRootDir = path.join(this.workspacesRootDir, 'provider-mirror');
    const providerMirrorDir = path.join(providerMirrorRootDir, PROVIDER_MIRROR_REGISTRY_PATH);
    const cliConfigFilePath = path.join(providerMirrorRootDir, 'tofu.tfrc');

    await fs.mkdir(providerMirrorDir, { recursive: true });
    await fs.copyFile(providerZipPath, path.join(providerMirrorDir, path.basename(providerZipPath)));
    await fs.writeFile(
      cliConfigFilePath,
      [
        'provider_installation {',
        '  filesystem_mirror {',
        `    path    = "${providerMirrorRootDir}"`,
        '    include = ["registry.opentofu.org/aliyun/alicloud"]',
        '  }',
        '  direct {',
        '    exclude = ["registry.opentofu.org/aliyun/alicloud"]',
        '  }',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );

    return {
      ...runnerEnv,
      TF_CLI_CONFIG_FILE: cliConfigFilePath,
    };
  }

  private resolveRuntimeConfig(
    runtimeConfig?: ResolvedProvisioningRuntimeConfig,
  ): ResolvedProvisioningRuntimeConfig {
    return {
      accessKeyId:
        normalizeOptionalEnvValue(runtimeConfig?.accessKeyId) ??
        requireEnvValue(this.env.ALICLOUD_ACCESS_KEY, 'ALICLOUD_ACCESS_KEY'),
      accessKeySecret:
        normalizeOptionalEnvValue(runtimeConfig?.accessKeySecret) ??
        requireEnvValue(this.env.ALICLOUD_SECRET_KEY, 'ALICLOUD_SECRET_KEY'),
      defaultRegion:
        normalizeOptionalEnvValue(runtimeConfig?.defaultRegion) ??
        requireEnvValue(this.env.ALICLOUD_REGION, 'ALICLOUD_REGION'),
      defaultZoneId:
        normalizeOptionalEnvValue(runtimeConfig?.defaultZoneId) ??
        requireEnvValue(this.env.ALICLOUD_ZONE_ID, 'ALICLOUD_ZONE_ID'),
    };
  }

  private readSystemDiskCategory() {
    return normalizeOptionalEnvValue(this.env.OPENTOFU_SYSTEM_DISK_CATEGORY);
  }
}

async function assertDirectoryExists(targetPath: string, message: string) {
  const stat = await fs.stat(targetPath).catch(() => null);

  if (!stat?.isDirectory()) {
    throw new Error(`${message}: ${targetPath}`);
  }
}

async function assertFileExists(targetPath: string, message: string) {
  const stat = await fs.stat(targetPath).catch(() => null);

  if (!stat?.isFile()) {
    throw new Error(`${message}: ${targetPath}`);
  }
}

function requireEnvValue(value: string | null | undefined, name: string): string {
  const trimmed = normalizeOptionalEnvValue(value);

  if (!trimmed) {
    throw new Error(`Missing required OpenTofu setting: ${name}`);
  }

  return trimmed;
}

function requireRuntimePassword(runtimeCredentials: RangeRuntimeCredentials | undefined, hostKey: string): string {
  const password = normalizeOptionalEnvValue(runtimeCredentials?.[hostKey]?.password);

  if (!password) {
    throw new Error(`Missing persisted runtime password for host: ${hostKey}`);
  }

  return password;
}

function normalizeOptionalEnvValue(value: string | null | undefined) {
  const trimmed = value?.trim();

  return trimmed ? trimmed : null;
}

function buildSingleInstanceName(config: SingleInstanceConfig) {
  return config.quantityIndex <= 1
    ? config.baseName
    : `${config.baseName}-${String(config.quantityIndex).padStart(2, '0')}`;
}

function readInstanceTypePreferences(env: OpenTofuProvisionerEnv) {
  const configuredPreferences = normalizeOptionalEnvValue(
    env.OPENTOFU_INSTANCE_TYPE_PREFERENCES ?? env.ALICLOUD_INSTANCE_TYPE_PREFERENCES,
  );

  if (!configuredPreferences) {
    return DEFAULT_AUTO_INSTANCE_TYPE_PREFERENCES;
  }

  const preferences = configuredPreferences
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  return preferences.length > 0 ? preferences : DEFAULT_AUTO_INSTANCE_TYPE_PREFERENCES;
}

function deriveInstanceTypePreferencesForResources(
  cpu: number | undefined,
  memoryGiB: number | undefined,
) {
  return resolvePreferredInstanceTypes(cpu, memoryGiB);
}

function buildHostInstanceResolutionHints(
  compiledProvisionSpec: Record<string, unknown> | null | undefined,
  compiledSpec: RangeTemplateCompiledSpec | null | undefined,
) {
  const hints = new Map<string, HostInstanceResolutionHint>();

  const compiledProvisionHosts = Array.isArray(compiledProvisionSpec?.hosts) ? compiledProvisionSpec.hosts : [];
  for (const hostValue of compiledProvisionHosts) {
    const hostRecord = readObjectRecord(hostValue);
    if (!hostRecord || typeof hostRecord.key !== 'string') {
      continue;
    }

    const existing = hints.get(hostRecord.key) ?? {};
    const finalImageId = resolveFinalImageIdFromRecord(hostRecord);
    hints.set(hostRecord.key, {
      ...existing,
      ...(typeof hostRecord.instanceTypePolicyKey === 'string'
        ? { instanceTypePolicyKey: hostRecord.instanceTypePolicyKey }
        : {}),
      ...(typeof hostRecord.instanceType === 'string'
        ? { finalInstanceType: hostRecord.instanceType }
        : {}),
      ...(finalImageId ? { finalImageId } : {}),
    });
  }

  const compiledResources = compiledSpec?.resources ?? [];
  for (const resource of compiledResources) {
    if (resource.type !== 'host') {
      continue;
    }

    const instanceTypeStrategy = normalizeHostInstanceTypeStrategy(resource.config.instanceTypeStrategy);
    const existing = hints.get(resource.id) ?? {};
    const finalImageId = resolveFinalImageIdFromRecord(resource.config);
    hints.set(resource.id, {
      ...existing,
      ...(typeof resource.config.cpu === 'number' ? { requestedCpu: resource.config.cpu } : {}),
      ...(typeof resource.config.memory === 'number' ? { requestedMemoryGiB: resource.config.memory } : {}),
      ...(typeof resource.config.instanceType === 'string'
        ? { finalInstanceType: resource.config.instanceType }
        : {}),
      ...(finalImageId ? { finalImageId } : {}),
      ...(instanceTypeStrategy ? { instanceTypeStrategy } : {}),
    });
  }

  return hints;
}

function normalizeHostInstanceTypeStrategy(value: unknown) {
  const record = readObjectRecord(value);
  if (!record) {
    return undefined;
  }

  const preferredInstanceTypes = readStringArrayValue(record.preferredInstanceTypes);

  return {
    ...(typeof record.mode === 'string' ? { mode: record.mode } : {}),
    ...(typeof record.instanceType === 'string' ? { instanceType: record.instanceType } : {}),
    preferredInstanceTypes,
  };
}

function normalizeHostImageStrategy(value: unknown) {
  const record = readObjectRecord(value);
  if (!record) {
    return undefined;
  }

  return {
    ...(typeof record.mode === 'string' ? { mode: record.mode } : {}),
    ...(typeof record.imageId === 'string' ? { imageId: record.imageId } : {}),
  };
}

function resolveFinalImageIdFromRecord(record: Record<string, unknown>) {
  const fixedImageId = normalizeExplicitFinalImageId(
    typeof record.imageId === 'string' ? record.imageId : undefined,
  );
  if (fixedImageId) {
    return fixedImageId;
  }

  const imageStrategy = normalizeHostImageStrategy(record.imageStrategy);
  if (imageStrategy?.mode === 'fixed' && imageStrategy.imageId) {
    return normalizeExplicitFinalImageId(imageStrategy.imageId);
  }

  return undefined;
}

function normalizeExplicitFinalImageId(value: string | null | undefined) {
  const normalizedValue = normalizeOptionalEnvValue(value);
  if (!normalizedValue) {
    return undefined;
  }

  if (/\.vhd$/i.test(normalizedValue)) {
    return normalizedValue;
  }

  if (/^m-[a-z0-9]+$/i.test(normalizedValue)) {
    return normalizedValue;
  }

  return undefined;
}

function resolveHostInstanceTypePolicy(input: {
  runtimeSelections: Record<string, unknown>;
  runtimeHint: HostInstanceResolutionHint | undefined;
}) {
  const runtimeSelectionRecord =
    input.runtimeHint?.instanceTypePolicyKey
      ? readObjectRecord(input.runtimeSelections[input.runtimeHint.instanceTypePolicyKey])
      : null;
  const strategy = input.runtimeHint?.instanceTypeStrategy;
  const mode =
    (typeof runtimeSelectionRecord?.mode === 'string' ? runtimeSelectionRecord.mode : undefined) ??
    strategy?.mode ??
    'auto';
  const explicitInstanceType = normalizeOptionalEnvValue(
    (typeof runtimeSelectionRecord?.instanceType === 'string' ? runtimeSelectionRecord.instanceType : undefined) ??
      strategy?.instanceType,
  );
  const preferredInstanceTypes = [
    ...readStringArrayValue(runtimeSelectionRecord?.preferredInstanceTypes),
    ...(strategy?.preferredInstanceTypes ?? []),
  ].filter((value, index, items) => items.indexOf(value) === index);

  if (mode === 'fixed' && explicitInstanceType) {
    return {
      fixedInstanceType: explicitInstanceType,
      preferredInstanceTypes: [] as string[],
      strictPreferredInstanceTypes: true,
    };
  }

  if (preferredInstanceTypes.length > 0) {
    return {
      preferredInstanceTypes,
      strictPreferredInstanceTypes: mode === 'fixed',
    };
  }

  if (input.runtimeHint?.finalInstanceType) {
    return {
      fixedInstanceType: input.runtimeHint.finalInstanceType,
      preferredInstanceTypes: [] as string[],
      strictPreferredInstanceTypes: true,
    };
  }

  const derivedPreferences = deriveInstanceTypePreferencesForResources(
    input.runtimeHint?.requestedCpu,
    input.runtimeHint?.requestedMemoryGiB,
  );

  if (derivedPreferences.length > 0) {
    return {
      preferredInstanceTypes: [...derivedPreferences],
      strictPreferredInstanceTypes: false,
    };
  }

  return {
    preferredInstanceTypes: [] as string[],
    strictPreferredInstanceTypes: false,
  };
}

function resolveFinalHostImageIds(input: {
  hostProvisioningHints: Map<string, HostInstanceResolutionHint>;
  hostKeys: string[];
  preferredHostKey: string;
}) {
  const resolvedHostImageIds: Record<string, string> = {};

  for (const hostKey of input.hostKeys) {
    const imageId = input.hostProvisioningHints.get(hostKey)?.finalImageId;
    if (imageId) {
      resolvedHostImageIds[hostKey] = imageId;
    }
  }

  if (Object.keys(resolvedHostImageIds).length === 0) {
    return undefined;
  }

  const preferredImageId = resolvedHostImageIds[input.preferredHostKey];
  if (!preferredImageId) {
    return resolvedHostImageIds;
  }

  return {
    [input.preferredHostKey]: preferredImageId,
    ...resolvedHostImageIds,
  };
}

function resolveGlobalHostImageId(hostImageIds: Record<string, string> | undefined) {
  if (!hostImageIds) {
    return undefined;
  }

  const uniqueImageIds = [...new Set(Object.values(hostImageIds))];

  if (uniqueImageIds.length > 1) {
    throw new Error(
      `Conflicting final host image IDs are not supported by the current OpenTofu runtime: ${uniqueImageIds.join(', ')}`,
    );
  }

  return uniqueImageIds[0];
}

function readImageIdPreferences(env: OpenTofuProvisionerEnv) {
  const configuredPreferences = normalizeOptionalEnvValue(
    env.OPENTOFU_IMAGE_ID_PREFERENCES ?? env.ALICLOUD_IMAGE_ID_PREFERENCES,
  );

  if (!configuredPreferences) {
    return DEFAULT_AUTO_IMAGE_ID_PREFERENCES;
  }

  const preferences = configuredPreferences
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  return preferences.length > 0 ? preferences : DEFAULT_AUTO_IMAGE_ID_PREFERENCES;
}

async function resolveAvailableAliyunInstanceType(
  input: AvailableInstanceTypeResolverInput,
): Promise<string> {
  const payload = await performAliyunRpcRequest({
    accessKeyId: input.accessKey,
    accessKeySecret: input.secretKey,
    regionId: input.regionId,
    action: 'DescribeAvailableResource',
    parameters: {
      ZoneId: input.zoneId,
      DestinationResource: 'InstanceType',
      ResourceType: 'instance',
      InstanceChargeType: 'PostPaid',
      IoOptimized: 'optimized',
      NetworkCategory: 'vpc',
      ...(input.systemDiskCategory ? { SystemDiskCategory: input.systemDiskCategory } : {}),
    },
  });
  const availableInstanceTypes = extractAvailableInstanceTypes(
    payload,
  );
  const selectedInstanceType =
    input.preferredInstanceTypes.find((candidate) =>
      availableInstanceTypes.includes(candidate),
    ) ?? availableInstanceTypes[0];

  if (!selectedInstanceType) {
    throw new Error(
      `No saleable ECS instance type found for zone ${input.zoneId} in region ${input.regionId}`,
    );
  }

  if (
    input.strictPreferredInstanceTypes &&
    input.preferredInstanceTypes.length > 0 &&
    !input.preferredInstanceTypes.includes(selectedInstanceType)
  ) {
    throw new Error(
      `No saleable ECS instance type matched requested preferences for zone ${input.zoneId} in region ${input.regionId}`,
    );
  }

  return selectedInstanceType;
}

async function resolveAvailableAliyunImageId(
  input: AvailableImageIdResolverInput,
): Promise<string> {
  const payload = await performAliyunRpcRequest({
    accessKeyId: input.accessKey,
    accessKeySecret: input.secretKey,
    regionId: input.regionId,
    action: 'DescribeImages',
    parameters: {
      ImageOwnerAlias: 'system',
      Status: 'Available',
      OSType: 'linux',
      Architecture: 'x86_64',
      PageSize: '100',
    },
  });
  const availableImageIds = extractAvailableImageIds(payload);

  if (input.requestedImageId) {
    if (!availableImageIds.includes(input.requestedImageId)) {
      throw new Error(
        `Configured image ID is not available in region ${input.regionId}: ${input.requestedImageId}`,
      );
    }

    return input.requestedImageId;
  }

  const selectedImageId =
    input.preferredImageIds.find((candidate) => availableImageIds.includes(candidate)) ??
    availableImageIds[0];

  if (!selectedImageId) {
    throw new Error(`No saleable ECS system image found in region ${input.regionId}`);
  }

  return selectedImageId;
}

async function performAliyunRpcRequest(input: {
  accessKeyId: string;
  accessKeySecret: string;
  regionId: string;
  action: string;
  parameters?: Record<string, string>;
}) {
  const endpoint = `https://ecs.${input.regionId}.aliyuncs.com/`;
  const query = signAliyunRpcQuery(
    {
      Action: input.action,
      AccessKeyId: input.accessKeyId,
      Format: ALICLOUD_RPC_FORMAT,
      RegionId: input.regionId,
      SignatureMethod: ALICLOUD_RPC_SIGNATURE_METHOD,
      SignatureNonce: randomUUID(),
      SignatureVersion: ALICLOUD_RPC_SIGNATURE_VERSION,
      Timestamp: formatAliyunTimestamp(new Date()),
      Version: ALICLOUD_RPC_API_VERSION,
      ...(input.parameters ?? {}),
    },
    input.accessKeySecret,
  );

  const response = await fetch(`${endpoint}?${query}`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
  });

  let payload: unknown = null;

  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const errorCode =
      payload && typeof payload === 'object' && 'Code' in payload && typeof (payload as { Code?: unknown }).Code === 'string'
        ? (payload as { Code: string }).Code
        : `HTTP_${response.status}`;
    const errorMessage =
      payload && typeof payload === 'object' && 'Message' in payload && typeof (payload as { Message?: unknown }).Message === 'string'
        ? (payload as { Message: string }).Message
        : `Aliyun RPC request failed with status ${response.status}`;

    throw new Error(`${input.action} failed: ${errorCode} - ${errorMessage}`);
  }

  return payload;
}

function signAliyunRpcQuery(parameters: Record<string, string>, accessKeySecret: string) {
  const canonicalizedQuery = Object.entries(parameters)
    .sort(([leftKey], [rightKey]) => compareAliyunRpcKeys(leftKey, rightKey))
    .map(([key, value]) => `${percentEncodeAliyunRpc(key)}=${percentEncodeAliyunRpc(value)}`)
    .join('&');
  const stringToSign = `GET&${percentEncodeAliyunRpc('/')}&${percentEncodeAliyunRpc(canonicalizedQuery)}`;
  const signature = createHmac('sha1', `${accessKeySecret}&`).update(stringToSign).digest('base64');

  return `${canonicalizedQuery}&Signature=${percentEncodeAliyunRpc(signature)}`;
}

function percentEncodeAliyunRpc(value: string) {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%7E/g, '~');
}

function compareAliyunRpcKeys(leftKey: string, rightKey: string) {
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function formatAliyunTimestamp(value: Date) {
  return value.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function extractAvailableInstanceTypes(payload: unknown) {
  const availableZones = normalizeAliyunRpcArray(
    (payload as {
      AvailableZones?: {
        AvailableZone?:
          | {
              AvailableResources?: {
                AvailableResource?:
                  | {
                      Type?: string;
                      SupportedResources?: {
                        SupportedResource?:
                          | {
                              Status?: string;
                              Value?: string;
                            }
                          | Array<{
                              Status?: string;
                              Value?: string;
                            }>;
                      };
                    }
                  | Array<{
                      Type?: string;
                      SupportedResources?: {
                        SupportedResource?:
                          | {
                              Status?: string;
                              Value?: string;
                            }
                          | Array<{
                              Status?: string;
                              Value?: string;
                            }>;
                      };
                    }>;
              };
            }
          | Array<{
              AvailableResources?: {
                AvailableResource?:
                  | {
                      Type?: string;
                      SupportedResources?: {
                        SupportedResource?:
                          | {
                              Status?: string;
                              Value?: string;
                            }
                          | Array<{
                              Status?: string;
                              Value?: string;
                            }>;
                      };
                    }
                  | Array<{
                      Type?: string;
                      SupportedResources?: {
                        SupportedResource?:
                          | {
                              Status?: string;
                              Value?: string;
                            }
                          | Array<{
                              Status?: string;
                              Value?: string;
                            }>;
                      };
                    }>;
              };
            }>;
      };
    })?.AvailableZones?.AvailableZone,
  );

  return [
    ...new Set(
      availableZones.flatMap((zone) =>
        normalizeAliyunRpcArray(zone.AvailableResources?.AvailableResource)
          .filter((resource) => resource.Type === 'InstanceType')
          .flatMap((resource) => normalizeAliyunRpcArray(resource.SupportedResources?.SupportedResource))
          .filter((resource) => resource.Status === 'Available' && typeof resource.Value === 'string')
          .map((resource) => resource.Value!.trim())
          .filter(Boolean),
      ),
    ),
  ];
}

function extractAvailableImageIds(payload: unknown) {
  const images = normalizeAliyunRpcArray(
    (payload as {
      Images?: {
        Image?:
          | {
              ImageId?: string;
              Status?: string;
            }
          | Array<{
              ImageId?: string;
              Status?: string;
            }>;
      };
    })?.Images?.Image,
  );

  return images
    .filter((image) => image.Status === 'Available' && typeof image.ImageId === 'string')
    .map((image) => image.ImageId!.trim())
    .filter(Boolean);
}

function normalizeAliyunRpcArray<T>(value: T | T[] | null | undefined) {
  if (!value) {
    return [] as T[];
  }

  return Array.isArray(value) ? value : [value];
}

function readObjectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function readStringArrayValue(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function pickEnv<K extends keyof NodeJS.ProcessEnv>(
  env: Partial<Pick<NodeJS.ProcessEnv, K>>,
  keys: readonly K[],
): NodeJS.ProcessEnv {
  const picked: NodeJS.ProcessEnv = {};

  for (const key of keys) {
    const value = env[key];

    if (value) {
      picked[key] = value;
    }
  }

  return picked;
}

function resolveWorkspaceRootDir(options: {
  projectRootDir: string;
  workspacesRootDir?: string;
  env: OpenTofuProvisionerEnv;
}) {
  const candidate =
    options.workspacesRootDir ?? options.env.OPENTOFU_WORKSPACES_ROOT ?? DEFAULT_WORKSPACES_ROOT;

  return path.isAbsolute(candidate)
    ? candidate
    : path.resolve(options.projectRootDir, candidate);
}

function readOutputValue<T>(output: OpenTofuOutputValue<T> | undefined): T | null {
  return output?.value ?? null;
}

async function runProvisionStep<T>(
  reportStep: RangeProvisionStepReporter | undefined,
  stepName: string,
  action: () => Promise<{
    result: T;
    message?: string | null;
    stdoutExcerpt?: string | null;
    stderrExcerpt?: string | null;
  }>,
): Promise<T> {
  await reportStep?.({
    stepName,
    status: 'running',
  });

  try {
    const outcome = await action();

    await reportStep?.({
      stepName,
      status: 'succeeded',
      message: outcome.message ?? null,
      stdoutExcerpt: trimExcerpt(outcome.stdoutExcerpt),
      stderrExcerpt: trimExcerpt(outcome.stderrExcerpt),
    });

    return outcome.result;
  } catch (error) {
    const failure = readStepFailure(error);

    await reportStep?.({
      stepName,
      status: 'failed',
      message: failure.message,
      stdoutExcerpt: trimExcerpt(failure.stdoutExcerpt),
      stderrExcerpt: trimExcerpt(failure.stderrExcerpt),
    });

    throw error;
  }
}

function readStepFailure(error: unknown) {
  if (error instanceof Error) {
    const failure = error as Error & {
      stdout?: string;
      stderr?: string;
    };

    return {
      message: failure.message,
      stdoutExcerpt: failure.stdout ?? null,
      stderrExcerpt: failure.stderr ?? null,
    };
  }

  return {
    message: 'Unknown OpenTofu step failure',
    stdoutExcerpt: null,
    stderrExcerpt: null,
  };
}

function trimExcerpt(value: string | null | undefined, limit = 4000) {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  return trimmed.length <= limit ? trimmed : trimmed.slice(trimmed.length - limit);
}
