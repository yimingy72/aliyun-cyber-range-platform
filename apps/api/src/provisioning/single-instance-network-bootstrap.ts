import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  OpenTofuRunner,
  type OpenTofuApplyOptions,
  type OpenTofuCommandResult,
  type OpenTofuPlanOptions,
  type OpenTofuValidateOptions,
  type OpenTofuWorkspaceCommandOptions,
} from '@aliyun-cyber-range/iac-runner';
import { Injectable } from '@nestjs/common';

import { buildBillingTags } from '../admin/billing-tagging';
import type { UpsertSingleInstanceNetworkProfileInput } from '../admin/admin.repository';
import { CidrPoolService } from './cidr-pool.service';
import type { ResolvedProvisioningRuntimeConfig } from './provisioning.types';

type BootstrapEnv = Partial<
  Pick<
    NodeJS.ProcessEnv,
    | 'ALICLOUD_PROVIDER_ZIP_PATH'
    | 'OPENTOFU_BINARY'
    | 'OPENTOFU_WORKSPACES_ROOT'
    | 'PATH'
    | 'TF_CLI_CONFIG_FILE'
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

type BootstrapRunnerLike = {
  init(options: OpenTofuWorkspaceCommandOptions): Promise<OpenTofuCommandResult>;
  validate(options: OpenTofuValidateOptions): Promise<OpenTofuCommandResult>;
  plan(options: OpenTofuPlanOptions): Promise<OpenTofuCommandResult>;
  apply(options: OpenTofuApplyOptions): Promise<OpenTofuCommandResult>;
  output<T>(options: OpenTofuWorkspaceCommandOptions): Promise<T>;
};

const DEFAULT_WORKSPACES_ROOT = '.local/opentofu-workspaces';
const PROVIDER_MIRROR_REGISTRY_PATH = path.join(
  'registry.opentofu.org',
  'aliyun',
  'alicloud',
);
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
    provider: 'alibaba_cloud';
    regionId: string;
    zoneId: string;
    occupiedCidrs?: string[];
    runtimeConfig: ResolvedProvisioningRuntimeConfig;
  }): Promise<UpsertSingleInstanceNetworkProfileInput> {
    const workspaceDir = path.join(
      this.workspacesRootDir,
      `single-instance-network-${input.regionId}-${input.zoneId}`,
    );
    const planFilePath = path.join(workspaceDir, 'single-instance-network.tfplan');
    const outputsFilePath = path.join(workspaceDir, 'outputs.json');
    const varsFilePath = path.join(workspaceDir, 'terraform.tfvars.json');
    const moduleDir = path.resolve(
      this.projectRootDir,
      'infra/opentofu/modules/alicloud-single-instance-network',
    );
    const existingWorkspaceConfig = await readExistingWorkspaceConfig(workspaceDir);
    const vpcCidr =
      existingWorkspaceConfig?.vpcCidr ??
      this.cidrPoolService.allocate(this.cidrPoolService.getPool(), input.occupiedCidrs ?? []);
    const vswitchCidrs = existingWorkspaceConfig?.vswitchCidrs ?? deriveVswitchCidrs(vpcCidr);

    await assertDirectoryExists(moduleDir, 'OpenTofu module path does not exist');
    await fs.mkdir(workspaceDir, { recursive: true });

    const files = buildBootstrapWorkspaceFiles(moduleDir, {
      resourceNamePrefix: `single-default-${sanitizeName(input.regionId)}-${sanitizeName(input.zoneId)}`,
      zoneId: input.zoneId,
      vpcCidr,
      vswitchCidrs,
      tags: buildBillingTags({
        billingScope: 'platform',
        billingStartAt: new Date(),
      }),
    });

    await Promise.all(
      Object.entries(files).map(async ([fileName, contents]) => {
        await fs.writeFile(path.join(workspaceDir, fileName), contents, 'utf8');
      }),
    );

    const runnerEnv = await this.buildRunnerEnv(input.runtimeConfig);

    await this.runner.init({ workspaceDir, env: runnerEnv });
    await this.runner.validate({
      workspaceDir,
      env: runnerEnv,
      varsFilePath,
    });
    await this.runner.plan({
      workspaceDir,
      env: runnerEnv,
      planFilePath,
      varsFilePath,
    });
    await this.runner.apply({
      workspaceDir,
      env: runnerEnv,
      planFilePath,
    });

    const outputs = await this.runner.output<{
      vpc_id?: { value?: string };
      vswitch_ids?: { value?: string[] };
      security_group_id?: { value?: string };
      security_group_name?: { value?: string };
    }>({
      workspaceDir,
      env: runnerEnv,
    });

    await fs.writeFile(outputsFilePath, `${JSON.stringify(outputs, null, 2)}\n`, 'utf8');

    return {
      provider: input.provider,
      regionId: input.regionId,
      zoneId: input.zoneId,
      vpcId: requireOutputValue(outputs.vpc_id?.value, 'vpc_id'),
      vpcCidr,
      vswitchIds: requireOutputValue(outputs.vswitch_ids?.value, 'vswitch_ids'),
      vswitchCidrs,
      securityGroupId: requireOutputValue(outputs.security_group_id?.value, 'security_group_id'),
      securityGroupName:
        outputs.security_group_name?.value?.trim() || 'single-instance-default-open-all',
    };
  }

  private async buildRunnerEnv(runtimeConfig: ResolvedProvisioningRuntimeConfig) {
    const providerZipPath = this.env.ALICLOUD_PROVIDER_ZIP_PATH?.trim();
    const runnerEnv: NodeJS.ProcessEnv = {
      ...pickEnv(process.env, RUNNER_ENV_KEYS),
      ...pickEnv(this.env, RUNNER_ENV_KEYS),
      ALICLOUD_ACCESS_KEY: runtimeConfig.accessKeyId,
      ALICLOUD_SECRET_KEY: runtimeConfig.accessKeySecret,
      ALICLOUD_REGION: runtimeConfig.defaultRegion,
    };

    if ((this.env.OPENTOFU_PASSTHROUGH_PROXY ?? '').trim() === '1') {
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
}

function buildBootstrapWorkspaceFiles(
  moduleSource: string,
  input: {
    resourceNamePrefix: string;
    zoneId: string;
    vpcCidr: string;
    vswitchCidrs: string[];
    tags: Record<string, string>;
  },
) {
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
      version = "~> 1.253"
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
    };
    const vpcCidr = typeof parsed.vpc_cidr === 'string' ? parsed.vpc_cidr.trim() : '';
    const vswitchCidrs = Array.isArray(parsed.vswitch_cidrs)
      ? parsed.vswitch_cidrs.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : [];

    if (!vpcCidr || vswitchCidrs.length !== 3) {
      return null;
    }

    return {
      vpcCidr,
      vswitchCidrs,
    };
  } catch {
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

function pickEnv<const Keys extends readonly string[]>(
  source: Partial<NodeJS.ProcessEnv> | undefined,
  keys: Keys,
) {
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
