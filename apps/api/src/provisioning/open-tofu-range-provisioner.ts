import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  OpenTofuRunner,
  type OpenTofuApplyOptions,
  type OpenTofuDestroyOptions,
  type OpenTofuCommandResult,
  type OpenTofuPlanOptions,
  type OpenTofuValidateOptions,
  type OpenTofuWorkspaceCommandOptions,
} from '@aliyun-cyber-range/iac-runner';

import { DryRunRangeProvisioner } from './dry-run-range-provisioner';
import {
  type RangeProvisionCreateInput,
  type RangeProvisionCreateResult,
  type RangeProvisionDestroyInput,
  type RangeProvisioner,
  type RangeProvisionStepReporter,
} from './provisioning.types';
import type { RangeTemplateHost, RangeTemplateNetworkZone, RangeTemplateTopologySpec } from '../admin/admin.repository';

type OpenTofuProvisionerEnv = Partial<
  Pick<
    NodeJS.ProcessEnv,
    | 'ALICLOUD_ACCESS_KEY'
    | 'ALICLOUD_SECRET_KEY'
    | 'ALICLOUD_REGION'
    | 'ALICLOUD_ZONE_ID'
    | 'ALICLOUD_INSTANCE_TYPE'
    | 'ALICLOUD_INSTANCE_TYPE_PREFERENCES'
    | 'ALICLOUD_PROVIDER_ZIP_PATH'
    | 'RANGE_PROVISIONER_MODE'
    | 'OPENTOFU_BINARY'
    | 'OPENTOFU_WORKSPACES_ROOT'
    | 'OPENTOFU_INSTANCE_TYPE'
    | 'OPENTOFU_INSTANCE_TYPE_PREFERENCES'
    | 'OPENTOFU_IMAGE_ID'
    | 'OPENTOFU_INSTANCE_PASSWORD'
    | 'OPENTOFU_ALLOWED_INGRESS_CIDR'
    | 'OPENTOFU_SYSTEM_DISK_CATEGORY'
    | 'OPENTOFU_SYSTEM_DISK_SIZE'
    | 'OPENTOFU_INTERNET_MAX_BANDWIDTH_OUT'
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
    eip_allocation_id?: string;
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
  availableInstanceTypeResolver?: AvailableInstanceTypeResolver;
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
};

type AvailableInstanceTypeResolver = (
  input: AvailableInstanceTypeResolverInput,
) => Promise<string>;

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
const execFileAsync = promisify(execFile);

export function createRangeProvisionerFromEnv(
  options: CreateRangeProvisionerFromEnvOptions = {},
): RangeProvisioner {
  const env = options.env ?? process.env;
  const mode = env.RANGE_PROVISIONER_MODE ?? 'dry-run';

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
  private readonly availableInstanceTypeResolver: AvailableInstanceTypeResolver;

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
    this.runner =
      options.runner ??
      new OpenTofuRunner({
        binaryPath: this.env.OPENTOFU_BINARY || 'tofu',
      });
    this.availableInstanceTypeResolver =
      options.availableInstanceTypeResolver ?? resolveAvailableAliyunInstanceType;
  }

  async create(input: RangeProvisionCreateInput): Promise<RangeProvisionCreateResult> {
    const workspace = await runProvisionStep(input.reportStep, 'render_template', async () => {
      const preparedWorkspace = await this.prepareWorkspace(input);

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

      await fs.writeFile(
        workspace.outputsFilePath,
        `${JSON.stringify(collectedOutputs, null, 2)}\n`,
        'utf8',
      );

      return {
        result: collectedOutputs,
        message: `Collected OpenTofu outputs into ${workspace.outputsFilePath}`,
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
        eipAllocationId: resourceSummary?.eip_allocation_id ?? null,
        topologySpec: {
          vpcCidr: input.topologySpec.vpcCidr,
          publicEntryHostKey: input.topologySpec.publicEntry.hostKey,
          networkZoneKeys: input.topologySpec.networkZones.map((zone) => zone.key),
          hostKeys: input.topologySpec.hosts.map((host) => host.key),
        },
      },
    };
  }

  async destroy(input: RangeProvisionDestroyInput): Promise<void> {
    const workspace = await runProvisionStep(input.reportStep, 'render_template', async () => {
      const preparedWorkspace = await this.prepareWorkspace(input);

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
  ): Promise<PreparedWorkspace> {
    const moduleDir = path.resolve(this.projectRootDir, input.templateModulePath);
    const workspaceDir = path.join(this.workspacesRootDir, input.rangeInstanceId);
    const planFilePath = path.join(workspaceDir, 'range.tfplan');
    const outputsFilePath = path.join(workspaceDir, 'outputs.json');
    const varsFilePath = path.join(workspaceDir, 'range.auto.tfvars.json');

    await assertDirectoryExists(moduleDir, 'OpenTofu module path does not exist');
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.cp(moduleDir, workspaceDir, {
      recursive: true,
    });

    const variables = await this.buildVariables(input);
    await fs.writeFile(varsFilePath, `${JSON.stringify(variables, null, 2)}\n`, 'utf8');

    const runnerEnv = await this.buildRunnerEnv();

    return {
      workspaceDir,
      planFilePath,
      outputsFilePath,
      varsFilePath,
      runnerEnv,
    };
  }

  private async buildVariables(input: RangeProvisionCreateInput | RangeProvisionDestroyInput) {
    const zoneId = requireEnvValue(this.env.ALICLOUD_ZONE_ID, 'ALICLOUD_ZONE_ID');
    const instanceType = await this.resolveInstanceType(zoneId);
    const imageId = requireEnvValue(this.env.OPENTOFU_IMAGE_ID, 'OPENTOFU_IMAGE_ID');
    const instancePassword = requireEnvValue(
      this.env.OPENTOFU_INSTANCE_PASSWORD,
      'OPENTOFU_INSTANCE_PASSWORD',
    );
    const networkPlan = readEnterpriseNetworkPlan(input.topologySpec, input.allocatedCidr);

    return {
      resource_name_prefix: createResourceNamePrefix(input.rangeInstanceId),
      zone_id: zoneId,
      vpc_cidr: networkPlan.vpcCidr,
      dmz_cidr: networkPlan.dmzCidr,
      office_cidr: networkPlan.officeCidr,
      server_cidr: networkPlan.serverCidr,
      dmz_private_ip: networkPlan.dmzPrivateIp,
      office_private_ip: networkPlan.officePrivateIp,
      server_private_ip: networkPlan.serverPrivateIp,
      instance_type: instanceType,
      image_id: imageId,
      instance_password: instancePassword,
      allowed_ingress_cidr: this.env.OPENTOFU_ALLOWED_INGRESS_CIDR ?? '0.0.0.0/0',
      ...(this.env.OPENTOFU_INTERNET_MAX_BANDWIDTH_OUT
        ? {
            internet_max_bandwidth_out: Number(this.env.OPENTOFU_INTERNET_MAX_BANDWIDTH_OUT),
          }
        : {}),
      ...(this.env.OPENTOFU_SYSTEM_DISK_CATEGORY
        ? {
            system_disk_category: this.env.OPENTOFU_SYSTEM_DISK_CATEGORY,
          }
        : {}),
      ...(this.env.OPENTOFU_SYSTEM_DISK_SIZE
        ? {
            system_disk_size: Number(this.env.OPENTOFU_SYSTEM_DISK_SIZE),
          }
        : {}),
      tags: {
        range_instance_id: input.rangeInstanceId,
      },
    };
  }

  private async resolveInstanceType(zoneId: string) {
    const requestedInstanceType = normalizeOptionalEnvValue(
      this.env.OPENTOFU_INSTANCE_TYPE ?? this.env.ALICLOUD_INSTANCE_TYPE,
    );

    if (requestedInstanceType && requestedInstanceType.toLowerCase() !== 'auto') {
      return requestedInstanceType;
    }

    const accessKey = requireEnvValue(this.env.ALICLOUD_ACCESS_KEY, 'ALICLOUD_ACCESS_KEY');
    const secretKey = requireEnvValue(this.env.ALICLOUD_SECRET_KEY, 'ALICLOUD_SECRET_KEY');
    const regionId = requireEnvValue(this.env.ALICLOUD_REGION, 'ALICLOUD_REGION');
    const systemDiskCategory = normalizeOptionalEnvValue(this.env.OPENTOFU_SYSTEM_DISK_CATEGORY);

    return this.availableInstanceTypeResolver({
      accessKey,
      secretKey,
      regionId,
      zoneId,
      ...(systemDiskCategory ? { systemDiskCategory } : {}),
      preferredInstanceTypes: readInstanceTypePreferences(this.env),
    });
  }

  private async buildRunnerEnv(): Promise<NodeJS.ProcessEnv> {
    const accessKey = requireEnvValue(this.env.ALICLOUD_ACCESS_KEY, 'ALICLOUD_ACCESS_KEY');
    const secretKey = requireEnvValue(this.env.ALICLOUD_SECRET_KEY, 'ALICLOUD_SECRET_KEY');
    const region = requireEnvValue(this.env.ALICLOUD_REGION, 'ALICLOUD_REGION');
    const providerZipPath = this.env.ALICLOUD_PROVIDER_ZIP_PATH?.trim();

    const runnerEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...this.env,
      ALICLOUD_ACCESS_KEY: accessKey,
      ALICLOUD_SECRET_KEY: secretKey,
      ALICLOUD_REGION: region,
    };

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

function normalizeOptionalEnvValue(value: string | null | undefined) {
  const trimmed = value?.trim();

  return trimmed ? trimmed : null;
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

async function resolveAvailableAliyunInstanceType(
  input: AvailableInstanceTypeResolverInput,
): Promise<string> {
  const args = [
    'ecs',
    'DescribeAvailableResource',
    '--RegionId',
    input.regionId,
    '--ZoneId',
    input.zoneId,
    '--DestinationResource',
    'InstanceType',
    '--ResourceType',
    'instance',
    '--InstanceChargeType',
    'PostPaid',
    '--IoOptimized',
    'optimized',
    '--NetworkCategory',
    'vpc',
  ];

  if (input.systemDiskCategory) {
    args.push('--SystemDiskCategory', input.systemDiskCategory);
  }

  const { stdout } = await execFileAsync('aliyun', args, {
    env: {
      ...process.env,
      ALICLOUD_ACCESS_KEY: input.accessKey,
      ALICLOUD_SECRET_KEY: input.secretKey,
    },
    maxBuffer: 8 * 1024 * 1024,
  });
  const availableInstanceTypes = extractAvailableInstanceTypes(
    JSON.parse(stdout.trim()),
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

  return selectedInstanceType;
}

function extractAvailableInstanceTypes(payload: unknown) {
  const availableZones =
    (payload as {
      AvailableZones?: {
        AvailableZone?: Array<{
          AvailableResources?: {
            AvailableResource?: Array<{
              Type?: string;
              SupportedResources?: {
                SupportedResource?: Array<{
                  Status?: string;
                  Value?: string;
                }>;
              };
            }>;
          };
        }>;
      };
    })?.AvailableZones?.AvailableZone ?? [];

  return [
    ...new Set(
      availableZones.flatMap((zone) =>
        (zone.AvailableResources?.AvailableResource ?? [])
          .filter((resource) => resource.Type === 'InstanceType')
          .flatMap((resource) => resource.SupportedResources?.SupportedResource ?? [])
          .filter((resource) => resource.Status === 'Available' && typeof resource.Value === 'string')
          .map((resource) => resource.Value!.trim())
          .filter(Boolean),
      ),
    ),
  ];
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

function createResourceNamePrefix(rangeInstanceId: string) {
  const normalized = rangeInstanceId.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();

  return `range-${normalized.slice(0, 9) || 'instance'}`;
}

function readOutputValue<T>(output: OpenTofuOutputValue<T> | undefined): T | null {
  return output?.value ?? null;
}

function readEnterpriseNetworkPlan(
  topologySpec: RangeTemplateTopologySpec,
  allocatedCidr: string | null,
) {
  const vpcCidr = requireEnvValue(topologySpec.vpcCidr, 'topologySpec.vpcCidr');

  if (allocatedCidr && allocatedCidr !== vpcCidr) {
    throw new Error(
      `Allocated CIDR ${allocatedCidr} does not match template topology VPC CIDR ${vpcCidr}`,
    );
  }

  const dmzZone = findZone(topologySpec, 'dmz');
  const officeZone = findZone(topologySpec, 'office');
  const serverZone = findZone(topologySpec, 'server');
  const dmzHost = findPublicEntryHost(topologySpec);
  const officeHost = findHostByZone(topologySpec, 'office');
  const serverHost = findHostByZone(topologySpec, 'server');

  return {
    vpcCidr,
    dmzCidr: dmzZone.cidr,
    officeCidr: officeZone.cidr,
    serverCidr: serverZone.cidr,
    dmzPrivateIp: dmzHost.privateIp,
    officePrivateIp: officeHost.privateIp,
    serverPrivateIp: serverHost.privateIp,
  };
}

function findZone(topologySpec: RangeTemplateTopologySpec, key: string): RangeTemplateNetworkZone {
  const zone = topologySpec.networkZones.find((item) => item.key === key);

  if (!zone) {
    throw new Error(`Template topology is missing required network zone: ${key}`);
  }

  return zone;
}

function findPublicEntryHost(topologySpec: RangeTemplateTopologySpec): RangeTemplateHost {
  const host = topologySpec.hosts.find((item) => item.key === topologySpec.publicEntry.hostKey);

  if (!host) {
    throw new Error(
      `Template topology public entry host not found: ${topologySpec.publicEntry.hostKey}`,
    );
  }

  return host;
}

function findHostByZone(topologySpec: RangeTemplateTopologySpec, zoneKey: string): RangeTemplateHost {
  const host = topologySpec.hosts.find((item) => item.zoneKey === zoneKey);

  if (!host) {
    throw new Error(`Template topology is missing required host in zone: ${zoneKey}`);
  }

  return host;
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
