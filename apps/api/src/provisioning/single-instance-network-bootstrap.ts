import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { APPLY_PENDING_FILE, fileExists, readWorkspaceState, recordApplyPlan, completeApply, hasUnresolvedApply, assertDestroyComplete, assertWorkspaceCanApply } from './opentofu-state-evidence';
import { prepareOpenTofuProviderEnv, migrateAliCloudWorkspaceProvider } from './provider-mirror-publication';
import { OpenTofuRunner, type OpenTofuInitOptions, type OpenTofuApplyOptions, type OpenTofuDestroyOptions, type OpenTofuCommandResult, type OpenTofuPlanOptions, type OpenTofuValidateOptions, type OpenTofuWorkspaceCommandOptions, type OpenTofuShowPlanOptions, } from '@aliyun-cyber-range/iac-runner';
import { Injectable } from '@nestjs/common';
import { buildBillingTags } from '../admin/billing-tagging';
import type { SingleInstanceNetworkProfileRecord, UpsertSingleInstanceNetworkProfileInput } from '../admin/admin.repository';
import { CidrPoolService } from './cidr-pool.service';
import type { ResolvedProvisioningRuntimeConfig } from './provisioning.types';
type BootstrapEnv = Partial<Pick<NodeJS.ProcessEnv, 'TENCENTCLOUD_PROVIDER_ZIP_PATH' | 'TENCENTCLOUD_PROVIDER_UNPACKED_MIRROR_ROOT' | 'ALICLOUD_PROVIDER_ZIP_PATH' | 'OPENTOFU_PROVIDER_UNPACKED_MIRROR_ROOT' | 'OPENTOFU_BINARY' | 'OPENTOFU_WORKSPACES_ROOT' | 'PATH' | 'TF_CLI_CONFIG_FILE' | 'OPENTOFU_PASSTHROUGH_PROXY' | 'HTTPS_PROXY' | 'HTTP_PROXY' | 'ALL_PROXY' | 'https_proxy' | 'http_proxy' | 'all_proxy' | 'NO_PROXY' | 'no_proxy'>>;
type BootstrapRunnerLike = {
  init(options: OpenTofuInitOptions): Promise<OpenTofuCommandResult>;
  validate(options: OpenTofuValidateOptions): Promise<OpenTofuCommandResult>;
  plan(options: OpenTofuPlanOptions): Promise<OpenTofuCommandResult>;
  apply(options: OpenTofuApplyOptions): Promise<OpenTofuCommandResult>;
  destroy(options: OpenTofuDestroyOptions): Promise<OpenTofuCommandResult>;
  output<T>(options: OpenTofuWorkspaceCommandOptions): Promise<T>;
  showPlan<T>(options: OpenTofuShowPlanOptions): Promise<T>;
};
const DEFAULT_WORKSPACES_ROOT = '.local/opentofu-workspaces';
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
@Injectable()
export class SingleInstanceNetworkBootstrapService {
  private readonly env: BootstrapEnv;
  private readonly runner: BootstrapRunnerLike;
  private readonly projectRootDir: string;
  private readonly workspacesRootDir: string;
  constructor(private readonly cidrPoolService: CidrPoolService) {
    this.env = process.env;
    this.runner = new OpenTofuRunner({
      binaryPath: this.env.OPENTOFU_BINARY || 'tofu',
    });
    this.projectRootDir = resolveProjectRootDir();
    this.workspacesRootDir = resolveWorkspacesRootDir(this.projectRootDir, this.env);
  }
  async bootstrapDefaultProfile(input: {
    provider: 'alibaba_cloud' | 'tencent_cloud';
    onApplyStart?: () => Promise<void>;
    onCleanupStart?: (profile: UpsertSingleInstanceNetworkProfileInput) => Promise<void>;
    onCleanupVerified?: () => Promise<void>;
    createdByUserId?:string;
    cloudAccountUid: string;
    cloudAccountContextId: string;
    regionId: string;
    zoneId: string;
    occupiedCidrs?: string[];
    runtimeConfig: ResolvedProvisioningRuntimeConfig;
  }): Promise<UpsertSingleInstanceNetworkProfileInput> {
    const workspaceDir = path.join(this.workspacesRootDir, singleNetworkWorkspaceKey(input.cloudAccountUid, input.regionId, input.zoneId, input.provider, input.cloudAccountContextId));
    const planFilePath = path.join(workspaceDir, 'single-instance-network.tfplan');
    const outputsFilePath = path.join(workspaceDir, 'outputs.json');
    const varsFilePath = path.join(workspaceDir, 'terraform.tfvars.json');
    const moduleDir = path.resolve(this.projectRootDir, input.provider === 'tencent_cloud' ? 'infra/opentofu/modules/tencentcloud-single-instance-network' : 'infra/opentofu/modules/alicloud-single-instance-network');
    if (input.runtimeConfig.provider && input.runtimeConfig.provider !== input.provider || input.runtimeConfig.defaultRegion !== input.regionId || input.runtimeConfig.defaultZoneId !== input.zoneId) throw new Error('Default network runtime differs from frozen cloud scope');
    for (const file of ['terraform.tfstate', 'terraform.tfstate.backup', 'errored.tfstate', APPLY_PENDING_FILE, '.range-apply-complete.json']) {
      if (await fileExists(path.join(workspaceDir, file)))
        throw new Error('Default network state or apply intent already exists without a registered profile; recover it before creating another network');
    }
    const existingWorkspaceConfig = await readExistingWorkspaceConfig(workspaceDir);
    const vpcCidr = existingWorkspaceConfig?.vpcCidr ??
      this.cidrPoolService.allocate(this.cidrPoolService.getPool(), input.occupiedCidrs ?? []);
    const vswitchCidrs = existingWorkspaceConfig?.vswitchCidrs ?? deriveVswitchCidrs(vpcCidr).slice(0, input.provider === 'tencent_cloud' ? 1 : 3);
    await assertDirectoryExists(moduleDir, 'OpenTofu module path does not exist');
    await fs.mkdir(workspaceDir, { recursive: true });
    const networkIdentity = { provider: input.provider, cloudAccountUid: input.cloudAccountUid, cloudAccountContextId: input.cloudAccountContextId, regionId: input.regionId, zoneId: input.zoneId };
    const intent = createHash('sha256').update(JSON.stringify(networkIdentity)).digest('hex').slice(0,32);
    await fs.writeFile(path.join(workspaceDir, 'single-network-identity.json'), JSON.stringify({ ...networkIdentity, creationIntentId: intent }), { mode: 0o600 });
    const files = input.provider === 'tencent_cloud' ? buildTencentBootstrapWorkspaceFiles(moduleDir, { ...networkIdentity, creationIntentId: intent, workspaceKey: path.basename(workspaceDir), vpcCidr, subnetCidr: vswitchCidrs[0] }) : buildBootstrapWorkspaceFiles(moduleDir, {
      resourceNamePrefix: `single-default-${sanitizeName(input.cloudAccountUid)}-${sanitizeName(input.regionId)}-${sanitizeName(input.zoneId)}`,
      zoneId: input.zoneId,
      vpcCidr,
      vswitchCidrs,
      tags: { CloudAccountUid: input.cloudAccountUid, CloudAccountContextId: input.cloudAccountContextId, ...buildBillingTags({
          billingScope: 'platform',
          platformResourceType: 'single_instance_network',
          platformNetworkProfileKey: `${input.regionId}:${input.zoneId}`,
          billingStartAt: new Date(),
        }) },
    });
    await Promise.all(Object.entries(files).map(async ([fileName, contents]) => {
      await fs.writeFile(path.join(workspaceDir, fileName), contents, 'utf8');
    }));
    const runnerEnv = await this.buildRunnerEnv(input.runtimeConfig);
    let applyInvoked = false;
    try {
      await this.runner.init({ workspaceDir, env: runnerEnv, upgrade: true });
      await this.runner.plan({
        workspaceDir,
        env: runnerEnv,
        planFilePath,
        varsFilePath,
      });
      const planned = await this.runner.showPlan({ workspaceDir, env: runnerEnv, planFilePath });
      await recordApplyPlan(workspaceDir, planned);
      await input.onApplyStart?.();
      applyInvoked = true;
      await this.runner.apply({
        workspaceDir,
        env: runnerEnv,
        planFilePath,
      });
      await completeApply(workspaceDir);
      const outputs = await this.runner.output<{
        vpc_id?: {
          value?: string;
        };
        vswitch_ids?: {
          value?: string[];
        };
        security_group_id?: {
          value?: string;
        };
        security_group_name?: {
          value?: string;
        };
      }>({
        workspaceDir,
        env: runnerEnv,
      });
      await fs.writeFile(outputsFilePath, `${JSON.stringify(outputs, null, 2)}\n`, 'utf8');
      return {
        provider: input.provider,
        cloudAccountUid: input.cloudAccountUid, cloudAccountContextId: input.cloudAccountContextId,
        workspaceKey: path.basename(workspaceDir), managedByPlatform: true,
        regionId: input.regionId,
        zoneId: input.zoneId,
        vpcId: requireOutputValue(outputs.vpc_id?.value, 'vpc_id'),
        vpcCidr,
        vswitchIds: requireOutputValue(outputs.vswitch_ids?.value, 'vswitch_ids'),
        vswitchCidrs,
        securityGroupId: requireOutputValue(outputs.security_group_id?.value, 'security_group_id'),
        securityGroupName: outputs.security_group_name?.value?.trim() || 'single-instance-default-open-all',
      };
    }
    catch (error) {
      if (!applyInvoked) {
        await input.onCleanupVerified?.();
        await fs.rm(workspaceDir, { recursive: true, force: true });
        throw error;
      }
      if (existsSync(path.join(workspaceDir, 'terraform.tfstate'))) {
        try {
          await this.assertOwnedState(workspaceDir, input.cloudAccountUid, input.provider, input.cloudAccountContextId);
          const priorState = (await readWorkspaceState(workspaceDir, true))!;
          const unresolvedApply = await hasUnresolvedApply(workspaceDir, priorState);
          const recovery = await this.readRecoveryProfile({ provider: input.provider, createdByUserId: input.createdByUserId, cloudAccountUid: input.cloudAccountUid, cloudAccountContextId: input.cloudAccountContextId, regionId: input.regionId, zoneId: input.zoneId });
          if (!recovery) throw new Error('Default network recovery identity is missing');
          await input.onCleanupStart?.(recovery);
          await this.runner.destroy({ workspaceDir, env: runnerEnv, varsFilePath });
          await assertDestroyComplete(workspaceDir, priorState, unresolvedApply);
          const remaining = await this.assertOwnedState(workspaceDir, input.cloudAccountUid, input.provider, input.cloudAccountContextId);
          if (remaining.some(value => value.instances.length))
            throw new Error('Default network cleanup did not finish');
          await input.onCleanupVerified?.();
          await fs.rm(workspaceDir, { recursive: true, force: true });
        }
        catch (cleanupError) {
          throw new Error(`Default network bootstrap failed; cleanup is required for ${path.basename(workspaceDir)}: ${cleanupError instanceof Error ? cleanupError.message : 'unknown cleanup error'}`);
        }
      }
      throw error;
    }
  }
  async readRecoveryProfile(input: {
    createdByUserId?:string;
    cloudAccountUid: string;
    cloudAccountContextId: string;
    regionId: string;
    zoneId: string;
    provider: 'alibaba_cloud' | 'tencent_cloud';
  }): Promise<UpsertSingleInstanceNetworkProfileInput | null> {
    const workspaceKey = singleNetworkWorkspaceKey(input.cloudAccountUid, input.regionId, input.zoneId, input.provider, input.cloudAccountContextId);
    const dir = path.join(this.workspacesRootDir, workspaceKey);
    let resources: Awaited<ReturnType<SingleInstanceNetworkBootstrapService['assertOwnedState']>> = [];
    try {
      if (await readWorkspaceState(dir)) resources = await this.assertOwnedState(dir, input.cloudAccountUid, input.provider, input.cloudAccountContextId);
      else return null;
    } catch {
      // Preserve unknown attempts as registered recovery work, including attempts with no returned resource ID.
      if (!(await Promise.all(['terraform.tfstate', 'terraform.tfstate.backup', 'errored.tfstate', APPLY_PENDING_FILE, '.range-apply-complete.json'].map(file => fileExists(path.join(dir, file))))).some(Boolean)) return null;
    }
    const config = await readExistingWorkspaceConfig(dir);
    const ids = (type: string) => resources.filter(value => value.type === type).flatMap(value => value.instances.map((entry: any) => String(entry.attributes.id)));
    return { ...input, status: 'destroying', workspaceKey, managedByPlatform: true, vpcId: ids(input.provider === 'tencent_cloud' ? 'tencentcloud_vpc' : 'alicloud_vpc')[0] ?? '', vpcCidr: config?.vpcCidr ?? '', vswitchIds: ids(input.provider === 'tencent_cloud' ? 'tencentcloud_subnet' : 'alicloud_vswitch'), vswitchCidrs: config?.vswitchCidrs ?? [], securityGroupId: ids(input.provider === 'tencent_cloud' ? 'tencentcloud_security_group' : 'alicloud_security_group')[0] ?? '', securityGroupName: 'single-instance-default-open-all' };
  }
  async recoverDefaultProfile(profile: SingleInstanceNetworkProfileRecord, runtimeConfig: ResolvedProvisioningRuntimeConfig) {
    const identity = { provider: profile.provider, cloudAccountUid: profile.cloudAccountUid,
      cloudAccountContextId: profile.cloudAccountContextId, regionId: profile.regionId, zoneId: profile.zoneId };
    if (!profile.managedByPlatform || !profile.cloudAccountUid || !profile.cloudAccountContextId || !profile.workspaceKey
      || runtimeConfig.provider !== profile.provider || runtimeConfig.accountUid !== profile.cloudAccountUid
      || runtimeConfig.cloudAccountContextId !== profile.cloudAccountContextId || runtimeConfig.defaultRegion !== profile.regionId
      || runtimeConfig.defaultZoneId !== profile.zoneId
      || profile.workspaceKey !== singleNetworkWorkspaceKey(profile.cloudAccountUid, profile.regionId, profile.zoneId, profile.provider, profile.cloudAccountContextId))
      throw new Error('Network recovery requires its exact frozen execution identity');
    const dir = path.join(this.workspacesRootDir, profile.workspaceKey);
    const recorded = JSON.parse(await fs.readFile(path.join(dir, 'single-network-identity.json'), 'utf8'));
    if (Object.entries(identity).some(([key, value]) => recorded[key] !== value)
      || recorded.creationIntentId !== createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 32))
      throw new Error('Network recovery workspace differs from its original creation intent');
    if (!await fileExists(path.join(dir, APPLY_PENDING_FILE)) && !await fileExists(path.join(dir, '.range-apply-complete.json')))
      throw new Error('Network recovery has no original apply evidence');
    await assertWorkspaceCanApply(dir, true);
    const resources = await this.assertOwnedState(dir, profile.cloudAccountUid, profile.provider, profile.cloudAccountContextId);
    const ids = (type: string) => resources.filter(resource => resource.type === type)
      .flatMap(resource => resource.instances.map(entry => String(entry.attributes.id)));
    const vpcIds = ids(profile.provider === 'tencent_cloud' ? 'tencentcloud_vpc' : 'alicloud_vpc');
    const groupIds = ids(profile.provider === 'tencent_cloud' ? 'tencentcloud_security_group' : 'alicloud_security_group');
    const vswitchIds = ids(profile.provider === 'tencent_cloud' ? 'tencentcloud_subnet' : 'alicloud_vswitch');
    const config = await readExistingWorkspaceConfig(dir);
    if (vpcIds.length !== 1 || groupIds.length !== 1 || vswitchIds.length !== (profile.provider === 'tencent_cloud' ? 1 : 3)
      || profile.vpcId && profile.vpcId !== vpcIds[0] || profile.securityGroupId && profile.securityGroupId !== groupIds[0]
      || profile.vswitchIds.some(id => !vswitchIds.includes(id)) || !config || config.vpcCidr !== profile.vpcCidr)
      throw new Error('Network recovery state conflicts with its persisted profile');
    return { ...profile, vpcId: vpcIds[0], securityGroupId: groupIds[0], vswitchIds,
      vswitchCidrs: config.vswitchCidrs };
  }
  async destroyDefaultProfile(profile: SingleInstanceNetworkProfileRecord, runtimeConfig: ResolvedProvisioningRuntimeConfig, onCleanupVerified?: () => Promise<void>) {
    if (!profile.managedByPlatform || !profile.cloudAccountUid || profile.workspaceKey !== singleNetworkWorkspaceKey(profile.cloudAccountUid, profile.regionId, profile.zoneId, profile.provider, profile.cloudAccountContextId ?? undefined))
      throw new Error('Only a bound, platform-created network profile can be destroyed');
    const dir = path.join(this.workspacesRootDir, profile.workspaceKey);
    const resources = await this.assertOwnedState(dir, profile.cloudAccountUid, profile.provider, profile.cloudAccountContextId ?? undefined);
    const ids = resources.filter(value => !['alicloud_security_group_rule', 'tencentcloud_security_group_rule_set'].includes(value.type)).flatMap(value => value.instances.map((entry: any) => String(entry.attributes.id))).sort();
    const expected = [profile.vpcId, profile.securityGroupId, ...profile.vswitchIds].filter(Boolean).sort();
    if (ids.some(id => !expected.includes(id)))
      throw new Error('Default network state does not match the requested profile');
    const priorState = (await readWorkspaceState(dir, true))!;
    const unresolvedApply = await hasUnresolvedApply(dir, priorState);
    const env = await this.buildRunnerEnv(runtimeConfig);
    if (profile.provider === 'alibaba_cloud') await migrateAliCloudWorkspaceProvider(dir);
    await this.runner.init({ workspaceDir: dir, env, upgrade: true });
    await this.runner.destroy({ workspaceDir: dir, env, varsFilePath: path.join(dir, 'terraform.tfvars.json') });
    await assertDestroyComplete(dir, priorState, unresolvedApply);
    const remaining = await this.assertOwnedState(dir, profile.cloudAccountUid, profile.provider, profile.cloudAccountContextId ?? undefined);
    if (remaining.some(value => value.instances.length))
      throw new Error('Default network state still contains resources after destroy');
    await onCleanupVerified?.();
    await fs.rm(dir, { recursive: true, force: true });
  }
  private async assertOwnedState(dir: string, accountUid: string, provider: 'alibaba_cloud' | 'tencent_cloud' = 'alibaba_cloud', contextId?: string) {
    const strictState = (await readWorkspaceState(dir, true))!;
    const state = { resources: strictState.instances.map(instance => ({ module: instance.module, mode: 'managed', type: instance.type, instances: [{ attributes: instance.attributes as Record<string, any> }] })) };
    const identity = provider === 'tencent_cloud' ? JSON.parse(await fs.readFile(path.join(dir, 'single-network-identity.json'), 'utf8')) : null;
    if (identity && (identity.provider !== provider || identity.cloudAccountUid !== accountUid || identity.cloudAccountContextId !== contextId || singleNetworkWorkspaceKey(accountUid, identity.regionId, identity.zoneId, provider, contextId) !== path.basename(dir))) throw new Error('Network workspace cloud identity differs from its frozen source');
    const allowed = new Set(provider === 'tencent_cloud' ? ['tencentcloud_vpc', 'tencentcloud_subnet', 'tencentcloud_security_group', 'tencentcloud_security_group_rule_set'] : ['alicloud_vpc', 'alicloud_vswitch', 'alicloud_security_group', 'alicloud_security_group_rule']);
    for (const resource of state.resources) {
      if (resource.mode !== 'managed' || resource.module !== 'module.network' || !allowed.has(resource.type))
        throw new Error('Default network state contains resources outside this profile');
      for (const entry of resource.instances)
        if (!['alicloud_security_group_rule', 'tencentcloud_security_group_rule_set'].includes(resource.type) && (entry.attributes.tags?.CloudAccountUid !== accountUid || entry.attributes.tags?.PlatformManaged !== 'true'
          || entry.attributes.tags?.CloudAccountContextId !== undefined && entry.attributes.tags.CloudAccountContextId !== contextId
          || identity && (entry.attributes.tags?.CloudAccountContextId !== contextId || entry.attributes.tags?.CreationIntentId !== identity.creationIntentId)))
          throw new Error('Default network state ownership could not be verified');
    }
    const groupIds = new Set(state.resources.filter(resource => ['alicloud_security_group', 'tencentcloud_security_group'].includes(resource.type)).flatMap(resource => resource.instances.map(entry => entry.attributes.id)));
    for (const resource of state.resources.filter(resource => ['alicloud_security_group_rule', 'tencentcloud_security_group_rule_set'].includes(resource.type))) {
      if (resource.instances.some(entry => !groupIds.has(entry.attributes.security_group_id)))
        throw new Error('Default network rule references another security group');
    }
    return state.resources;
  }
  private async buildRunnerEnv(runtimeConfig: ResolvedProvisioningRuntimeConfig) {
    const tencent = runtimeConfig.provider === 'tencent_cloud';
    const providerZipPath = (tencent ? this.env.TENCENTCLOUD_PROVIDER_ZIP_PATH : this.env.ALICLOUD_PROVIDER_ZIP_PATH)?.trim();
    const runnerEnv: NodeJS.ProcessEnv = {
      ...pickEnv(process.env, RUNNER_ENV_KEYS),
      ...pickEnv(this.env, RUNNER_ENV_KEYS),
      ...(tencent ? { TENCENTCLOUD_SECRET_ID: runtimeConfig.accessKeyId, TENCENTCLOUD_SECRET_KEY: runtimeConfig.accessKeySecret, TENCENTCLOUD_REGION: runtimeConfig.defaultRegion } : { ALICLOUD_ACCESS_KEY: runtimeConfig.accessKeyId, ALICLOUD_SECRET_KEY: runtimeConfig.accessKeySecret, ALICLOUD_REGION: runtimeConfig.defaultRegion }),
    };
    if ((this.env.OPENTOFU_PASSTHROUGH_PROXY ?? '').trim() === '1') {
      Object.assign(runnerEnv, pickEnv(process.env, PROXY_ENV_KEYS), pickEnv(this.env, PROXY_ENV_KEYS));
    }
    return {
      ...runnerEnv,
      ...await prepareOpenTofuProviderEnv({
        provider: runtimeConfig.provider, providerZipPath,
        workspacesRootDir: this.workspacesRootDir,
        unpackedMirrorRootDir: (tencent ? this.env.TENCENTCLOUD_PROVIDER_UNPACKED_MIRROR_ROOT : this.env.OPENTOFU_PROVIDER_UNPACKED_MIRROR_ROOT)?.trim(),
      }),
    };
  }
}
function buildBootstrapWorkspaceFiles(moduleSource: string, input: {
  resourceNamePrefix: string;
  zoneId: string;
  vpcCidr: string;
  vswitchCidrs: string[];
  tags: Record<string, string>;
}) {
  return {
    'main.tf': [
      'provider "alicloud" {}',
      '',
      'module "network" {',
      `  source = "${moduleSource}"`,
      '',
      '  resource_name_prefix = var.resource_name_prefix',
      '  zone_id              = var.zone_id',
      '  vpc_cidr             = var.vpc_cidr',
      '  vswitch_cidrs        = var.vswitch_cidrs',
      '  tags                 = var.tags',
      '}',
      '',
    ].join('\n'),
    'variables.tf': `variable "resource_name_prefix" {
 type = string
}

variable "zone_id" {
 type = string
}

variable "vpc_cidr" {
 type = string
}

variable "vswitch_cidrs" {
 type = list(string)
}

variable "tags" {
 type    = map(string)
 default = {}
}
`,
    'outputs.tf': `output "vpc_id" {
 value = module.network.vpc_id
}

output "vswitch_ids" {
 value = module.network.vswitch_ids
}

output "security_group_id" {
 value = module.network.security_group_id
}

output "security_group_name" {
 value = module.network.security_group_name
}
`,
    'versions.tf': `terraform {
 required_version = ">= 1.8.0"

 required_providers {
  alicloud = {
   source  = "aliyun/alicloud"
   version = "= 1.282.0-range.1"
  }
 }
}
`,
    'terraform.tfvars.json': `${JSON.stringify({
      resource_name_prefix: input.resourceNamePrefix,
      zone_id: input.zoneId,
      vpc_cidr: input.vpcCidr,
      vswitch_cidrs: input.vswitchCidrs,
      tags: input.tags,
    })}\n`,
  };
}
function deriveVswitchCidrs(vpcCidr: string) {
  const [network] = vpcCidr.split('/');
  const octets = network.split('.');
  if (octets.length !== 4) {
    throw new Error(`Unsupported single-instance VPC CIDR: ${vpcCidr}`);
  }
  return [1, 2, 3].map((suffix) => `${octets[0]}.${octets[1]}.${suffix}.0/24`);
}
async function readExistingWorkspaceConfig(workspaceDir: string) {
  const varsFilePath = path.join(workspaceDir, 'terraform.tfvars.json');
  const contents = await fs.readFile(varsFilePath, 'utf8').catch(() => null);
  if (!contents) {
    return null;
  }
  try {
    const parsed = JSON.parse(contents) as {
      vpc_cidr?: unknown;
      vswitch_cidrs?: unknown;
      subnet_cidr?: unknown;
    };
    const vpcCidr = typeof parsed.vpc_cidr === 'string' ? parsed.vpc_cidr.trim() : '';
    const vswitchCidrs = typeof parsed.subnet_cidr === 'string' ? [parsed.subnet_cidr] : Array.isArray(parsed.vswitch_cidrs)
      ? parsed.vswitch_cidrs.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : [];
    if (!vpcCidr || ![1,3].includes(vswitchCidrs.length)) {
      return null;
    }
    return {
      vpcCidr,
      vswitchCidrs,
    };
  }
  catch {
    return null;
  }
}
function requireOutputValue<T>(value: T | undefined, key: string) {
  if (value === undefined || value === null || value === '') {
    throw new Error(`OpenTofu bootstrap output missing ${key}`);
  }
  return value;
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
function pickEnv<const Keys extends readonly string[]>(source: Partial<NodeJS.ProcessEnv> | undefined, keys: Keys) {
  const picked: NodeJS.ProcessEnv = {};
  if (!source) {
    return picked;
  }
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined) {
      picked[key] = value;
    }
  }
  return picked;
}
function resolveProjectRootDir() {
  let currentDir = process.cwd();
  while (true) {
    if (pathExists(path.join(currentDir, 'pnpm-workspace.yaml'))) {
      return currentDir;
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return process.cwd();
    }
    currentDir = parentDir;
  }
}
function resolveWorkspacesRootDir(projectRootDir: string, env: BootstrapEnv) {
  const candidate = env.OPENTOFU_WORKSPACES_ROOT ?? DEFAULT_WORKSPACES_ROOT;
  return path.isAbsolute(candidate)
    ? candidate
    : path.resolve(projectRootDir, candidate);
}
function pathExists(targetPath: string) {
  return existsSync(targetPath);
}
function sanitizeName(value: string) {
  return value.replace(/[^a-zA-Z0-9-]+/g, '-');
}
export function singleNetworkWorkspaceKey(accountUid: string, region: string, zone: string, provider: 'alibaba_cloud' | 'tencent_cloud' = 'alibaba_cloud', contextId?: string) {
  if (provider === 'tencent_cloud') {
    if (!contextId) throw new Error('Tencent network requires a frozen account context');
    return `single-instance-network-tencent-${createHash('sha256').update(JSON.stringify([provider, accountUid, contextId, region, zone])).digest('hex').slice(0,40)}`;
  }
  return `single-instance-network-${sanitizeName(accountUid)}-${sanitizeName(region)}-${sanitizeName(zone)}`; }

function buildTencentBootstrapWorkspaceFiles(moduleSource: string, input: { cloudAccountUid: string; cloudAccountContextId: string; regionId: string; zoneId: string; workspaceKey: string; creationIntentId: string; vpcCidr: string; subnetCidr: string }) {
  const variables = { cloud_account_uid: input.cloudAccountUid, cloud_account_context_id: input.cloudAccountContextId, region: input.regionId, zone_id: input.zoneId,
    network_profile_id: input.workspaceKey, creation_intent_id: input.creationIntentId, resource_name_prefix: `single-${input.creationIntentId.slice(0,24)}`, vpc_cidr: input.vpcCidr, subnet_cidr: input.subnetCidr,
    ingress_rules: [{ cidr_block: '0.0.0.0/0', protocol: 'ALL', port: 'all' }] };
  return {
    'main.tf': `provider "tencentcloud" { region = var.region }\nmodule "network" {\n source = ${JSON.stringify(moduleSource)}\n${Object.keys(variables).map(key => ` ${key} = var.${key}`).join('\n')}\n}\n`,
    'variables.tf': Object.keys(variables).map(key => `variable "${key}" { type = ${key === 'ingress_rules' ? 'list(object({ cidr_block = string, protocol = string, port = string }))' : 'string'} }`).join('\n'),
    'outputs.tf': 'output "vpc_id" { value = module.network.network_profile.vpc_id }\noutput "vswitch_ids" { value = [module.network.network_profile.subnet_id] }\noutput "security_group_id" { value = module.network.network_profile.security_group_id }\noutput "security_group_name" { value = "single-instance-default-open-all" }\n',
    'versions.tf': 'terraform {\n required_providers {\n  tencentcloud = { source = "tencentcloudstack/tencentcloud", version = "= 1.83.34-range.1" }\n }\n}\n',
    'terraform.tfvars.json': JSON.stringify(variables)+'\n',
  };
}
