import { isIPv4 } from 'node:net';
import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { validateHostDnsConfig } from '@aliyun-cyber-range/scenario-runtime/compiled';
import { ADMIN_REPOSITORY, type AdminRepository, type RangeInstanceRecord } from './admin.repository';
import { runInExecutionCloudWorkspace } from '../auth/background-cloud-workspace';
import { SystemConfigService } from './system-config.service';
import { DnsGuestCommandClient } from './dns-guest-command-client';
import { buildWindowsDnsConfigurationScript, buildWindowsDnsVerificationScript, windowsDnsPolicyHash, type WindowsDnsTarget } from '../provisioning/renderers/guest-dns-scripts';
import { publicDnsVerification, type RangeDnsVerification, type DnsInterfaceView } from './range-dns-types';

type Actor = { id: string; role: string };
const record = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function deployedDnsPolicy(instance: RangeInstanceRecord, hostKey: string) {
  const nodes = Array.isArray(instance.runtimeTopologyGraph?.nodes) ? instance.runtimeTopologyGraph.nodes : [];
  const host = nodes.map(record).find(node => node.id === hostKey && node.kind === 'ecs');
  if (!host?.dns) throw new ConflictException('该主机没有已部署的自定义 DNS。');
  const nics = Array.isArray(host.nics) ? host.nics.map(record) : [];
  if (!nics.length || nics.length > 16 || nics.some(nic => typeof nic.id !== 'string' || !nic.id.length) || new Set(nics.map(nic => nic.id)).size !== nics.length || new Set(nics.map(nic => nic.privateIp)).size !== nics.length) throw new ConflictException('DNS 核验需要完整且唯一的已部署网卡身份。');
  const dns = validateHostDnsConfig(host.dns, nics.map(nic => nic.id), `hosts.${hostKey}.dns`);
  const interfaces = nics.map(nic => {
    if (!nic || typeof nic.privateIp !== 'string' || !isIPv4(nic.privateIp)) throw new ConflictException('DNS 作用网卡缺少已部署的固定私网 IP。');
    return { nicId: nic.id as string, privateIp: nic.privateIp };
  });
  const expected = dns.nicIds.map(nicId => ({ ...interfaces.find(nic => nic.nicId === nicId)!, servers: dns.servers }));
  return { dns, interfaces, expected, policyHash: windowsDnsPolicyHash({ dns, interfaces }) };
}

// The result must match this invocation and every deployed NIC. Never trust the guest's boolean/status alone.
export function parseDnsReadback(output: string, nonce: string, expected: DnsInterfaceView[], domain?: string, interfaces: WindowsDnsTarget[] = expected, policyHash?: string) {
  const lines = output.split(/\r?\n/).filter(line => line.startsWith('CYBER_RANGE_DNS_RESULT:'));
  if (lines.length !== 1) throw new Error('DNS_REPORT_INVALID');
  let result: Record<string, any>;
  try { result = record(JSON.parse(lines[0].slice('CYBER_RANGE_DNS_RESULT:'.length))); } catch { throw new Error('DNS_REPORT_INVALID'); }
  if (result.schemaVersion !== 1 || result.verificationNonce !== nonce || result.method !== (domain ? 'ad_srv' : 'readback')
    || !['verified', 'failed'].includes(result.status) || !Array.isArray(result.interfaces) || result.interfaces.length !== expected.length)
    throw new Error('DNS_REPORT_MISMATCH');
  const indices = new Set<number>();
  const validServers = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 16 && new Set(value).size === value.length && value.every(ip => typeof ip === 'string' && isIPv4(ip));
  const observedRows = result.observedInterfaces;
  if (!Array.isArray(observedRows) || observedRows.length !== interfaces.length) throw new Error('DNS_REPORT_MISMATCH');
  const observedInterfaces = interfaces.map(target => {
    const rows = observedRows.filter((row: any) => row?.nicId === target.nicId && row.privateIp === target.privateIp);
    if (rows.length !== 1 || !Number.isSafeInteger(rows[0].interfaceIndex) || rows[0].interfaceIndex < 1 || indices.has(rows[0].interfaceIndex) || !validServers(rows[0].actualServers)) throw new Error('DNS_REPORT_MISMATCH');
    indices.add(rows[0].interfaceIndex);
    return { ...target, servers: rows[0].actualServers as string[] };
  });
  const actual = expected.map(target => {
    const rows = result.interfaces.filter((row: any) => row?.nicId === target.nicId && row.privateIp === target.privateIp);
    const observed = observedRows.find((row: any) => row?.nicId === target.nicId && row.privateIp === target.privateIp);
    if (rows.length !== 1 || rows[0].interfaceIndex !== observed?.interfaceIndex || !equal(rows[0].expectedServers, target.servers) || !validServers(rows[0].actualServers) || !equal(rows[0].actualServers, observed.actualServers)) throw new Error('DNS_REPORT_MISMATCH');
    return { nicId: target.nicId, privateIp: target.privateIp, servers: rows[0].actualServers as string[] };
  });
  const matched = actual.every((row, index) => equal(row.servers, expected[index].servers));
  const servers = expected[0]?.servers ?? [];
  const resolved = !domain || Array.isArray(result.probes) && result.probes.length === servers.length && servers.every(server => {
    const probes = result.probes.filter((probe: any) => probe?.server === server);
    return probes.length === 1 && probes[0].status === 'verified' && Number.isSafeInteger(probes[0].recordCount) && probes[0].recordCount > 0;
  });
  const verified = matched && resolved && result.status === 'verified';
  const untouched = interfaces.filter(nic => !expected.some(selected => selected.nicId === nic.nicId));
  const baseline = record(result.baseline), baselineRows = baseline.interfaces;
  const baselineIndices = new Set<number>();
  const baselineValid = baseline.schemaVersion === 1 && typeof policyHash === 'string' && baseline.policyHash === policyHash && Array.isArray(baselineRows) && baselineRows.length === interfaces.length && interfaces.every(nic => {
    const rows = baselineRows.filter((row: any) => row?.nicId === nic.nicId && row.privateIp === nic.privateIp);
    if (rows.length !== 1 || !Number.isSafeInteger(rows[0].interfaceIndex) || rows[0].interfaceIndex < 1 || baselineIndices.has(rows[0].interfaceIndex) || !validServers(rows[0].actualServers)) return false;
    baselineIndices.add(rows[0].interfaceIndex); return true;
  });
  const untouchedInterfaces = baselineValid ? untouched.map(nic => ({ ...nic, baselineServers: baselineRows.find((row: any) => row.nicId === nic.nicId).actualServers as string[], actualServers: observedInterfaces.find(row => row.nicId === nic.nicId)!.servers })) : [];
  const preservationStatus = !untouched.length ? 'not_requested' as const : !baselineValid ? 'unverified' as const : untouchedInterfaces.every(row => equal(row.baselineServers, row.actualServers)) ? 'verified' as const : 'changed' as const;
  return { actual, status: verified ? 'verified' as const : 'failed' as const,
    observedInterfaces, untouchedInterfaces, preservationStatus,
    resolutionStatus: domain ? (resolved ? 'verified' as const : 'failed' as const) : 'not_requested' as const,
    ...(!verified ? { errorCode: !matched ? 'DNS_READBACK_MISMATCH' : !resolved ? 'DNS_AD_SRV_FAILED' : 'DNS_GUEST_CHECK_FAILED' } : {}) };
}

@Injectable()
export class RangeDnsVerificationService {
  private readonly client: DnsGuestCommandClient;
  private automaticQueue: Promise<void> = Promise.resolve();
  constructor(@Inject(ADMIN_REPOSITORY) private readonly repository: AdminRepository,
    private readonly config: SystemConfigService, @Optional() client?: DnsGuestCommandClient) { this.client = client ?? new DnsGuestCommandClient(); }

  scheduleAll(id: string, jobId: string, workspaceId: string | null | undefined) {
    // Guest readers have their own bounded queue, so Windows readiness never occupies a cloud provisioning slot.
    this.automaticQueue = this.automaticQueue.then(() => runInExecutionCloudWorkspace(this.config, workspaceId,
      () => this.verifyAll(id, jobId))).catch(() => undefined);
  }

  async verifyAll(id: string, jobId: string) {
    const range = await this.repository.getRangeInstanceById(id);
    const nodes = Array.isArray(range?.runtimeTopologyGraph?.nodes) ? range!.runtimeTopologyGraph!.nodes.map(record).filter(node => node.kind === 'ecs' && node.dns) : [];
    // Two readers at a time; neither this method nor its client has a create/destroy path.
    for (let offset = 0; offset < nodes.length; offset += 2) await Promise.all(nodes.slice(offset, offset + 2).map(async node => {
      const job = await this.repository.getProvisionJobById(jobId);
      if (job?.status !== 'succeeded' || job.rangeInstanceId !== id) return;
      const current = await this.repository.getRangeInstanceById(id);
      if (!current || current.lastJobId !== jobId || current.status !== 'running') return;
      const prior = current.resourceSummary?.dnsVerification?.[node.id];
      if (prior?.status === 'verified' && prior.instanceId === current.resourceSummary?.hostIds?.[node.id] && prior.policyHash === deployedDnsPolicy(current, node.id).policyHash) return;
      try { await this.verify(id, node.id, { id: range!.ownerUserId ?? 'system:worker', role: 'admin' }, jobId); } catch { /* Cloud lifecycle remains independent of guest verification. */ }
    }));
  }

  async verify(id: string, hostKey: string, actor: Actor, ownJobId?: string, configure = false) {
    const range = await this.repository.getRangeInstanceById(id);
    if (!range) throw new NotFoundException('Range instance not found');
    if (!actor || actor.role !== 'admin' && range.ownerUserId !== actor.id) throw new ForbiddenException('Range instance access denied');
    if (range.instanceMode !== 'range' || range.status !== 'running' || range.resourceSummary?.mode !== 'opentofu') throw new ConflictException('只能核验运行中的真实编排实例。');
    if ((await this.repository.listProvisionJobs()).some(job => job.rangeInstanceId === id && job.id !== ownJobId && ['pending', 'running'].includes(job.status))) throw new ConflictException('实例正在执行编排操作，请稍后核验。');
    const instanceId = range.resourceSummary.hostIds?.[hostKey];
    if (!instanceId) throw new NotFoundException('Range host not found');
    const policy = deployedDnsPolicy(range, hostKey), previous = range.resourceSummary.dnsVerification?.[hostKey];
    if (previous?.status === 'checking' && new Date(previous.expiresAt).getTime() > Date.now()) throw new ConflictException('该主机正在核验 DNS。');
    const claimId = randomUUID();
    const deadline = Date.now() + (configure ? 180_000 : 120_000);
    let state: RangeDnsVerification = { status: 'checking', method: policy.dns.domain ? 'ad_srv' : 'readback', expected: policy.expected,
      actual: [], observedInterfaces: [], untouchedInterfaces: [], preservationStatus: 'unverified', resolutionStatus: 'not_requested', instanceId, policyHash: policy.policyHash, claimId,
      expiresAt: new Date(Date.now() + (configure ? 240_000 : 180_000)).toISOString(),
      ...(!configure && previous?.instanceId === instanceId && previous.policyHash === policy.policyHash
        ? { configurationInvocationId: previous.configurationInvocationId, configurationRequestId: previous.configurationRequestId } : {}) };
    if (!await this.repository.updateRangeInstanceDnsState(id, hostKey, instanceId, previous?.claimId ?? null, state)) throw new ConflictException('实例已变化，请刷新后核验。');
    try {
      const contextId = range.resourceSummary.executionContext?.cloudAccountContextId;
      if (!contextId) throw new Error('DNS_FROZEN_ACCOUNT_MISSING');
      const account = await this.config.getAccountContextById(contextId);
      await this.client.assertOwned(range, hostKey, instanceId, account);
      const assertCurrent = async () => {
        const current = await this.repository.getRangeInstanceById(id);
        if (!current || current.status !== 'running' || current.resourceSummary?.hostIds?.[hostKey] !== instanceId || current.resourceSummary?.dnsVerification?.[hostKey]?.claimId !== claimId || deployedDnsPolicy(current, hostKey).policyHash !== policy.policyHash) throw new Error('DNS_INSTANCE_CHANGED');
      };
      const execute = async (script: string, domain: string | undefined, configuration = false) => {
        await assertCurrent();
        if (Date.now() >= deadline) throw new Error('DNS_COMMAND_TIMEOUT');
        const submission = await this.client.submit(account, instanceId, script, claimId);
        state = { ...state, status: 'checking', method: domain ? 'ad_srv' : 'readback', errorCode: undefined,
          ...(configuration ? { configurationInvocationId: submission.invocationId, configurationRequestId: submission.requestId }
            : { invocationId: submission.invocationId, cloudRequestId: submission.requestId }) };
        if (!await this.repository.updateRangeInstanceDnsState(id, hostKey, instanceId, claimId, state)) throw new Error('DNS_INSTANCE_CHANGED');
        let result;
        for (let attempt = 0; attempt < (configure ? 30 : 22) && Date.now() < deadline; attempt++) {
          await assertCurrent();
          result = await this.client.read(account, submission.invocationId, instanceId);
          if (result.status !== 'pending') break;
          await this.pause(3000);
        }
        if (!result || result.status === 'pending') throw new Error('DNS_COMMAND_TIMEOUT');
        if (result.status !== 'success' || result.exitCode !== 0) {
          if (result.output) { try { state = { ...state, ...parseDnsReadback(result.output, claimId, policy.expected, domain, policy.interfaces, policy.policyHash), status: 'failed' }; } catch { /* retain safe fixed failure */ } }
          state = { ...state, status: 'failed', errorCode: state.errorCode ?? 'DNS_COMMAND_FAILED' };
        } else state = { ...state, ...parseDnsReadback(result.output ?? '', claimId, policy.expected, domain, policy.interfaces, policy.policyHash) };
      };
      const scriptInput = { dns: policy.dns, interfaces: policy.interfaces, verificationNonce: claimId };
      if (configure) {
        await execute(buildWindowsDnsConfigurationScript(scriptInput), undefined, true);
        if (state.status === 'verified' && !['verified', 'not_requested'].includes(state.preservationStatus ?? 'unverified'))
          state = { ...state, status: 'failed', errorCode: 'DNS_CONFIGURATION_PRESERVATION_FAILED' };
      }
      if (!configure || state.status === 'verified') await execute(buildWindowsDnsVerificationScript(scriptInput), policy.dns.domain);
      if (configure && state.status === 'verified' && !['verified', 'not_requested'].includes(state.preservationStatus ?? 'unverified'))
        state = { ...state, status: 'failed', errorCode: 'DNS_CONFIGURATION_PRESERVATION_FAILED' };
    } catch (error) {
      const code = error instanceof Error && /^DNS_[A-Z_]+$/.test(error.message) ? error.message : 'DNS_AGENT_UNAVAILABLE';
      state = { ...state, status: 'unverified', errorCode: code };
    }
    const final = await this.repository.getRangeInstanceById(id);
    if (!final || final.status !== 'running' || final.resourceSummary?.hostIds?.[hostKey] !== instanceId || deployedDnsPolicy(final, hostKey).policyHash !== policy.policyHash) throw new ConflictException('核验过程中实例或 DNS 策略发生变化，请刷新。');
    state.checkedAt = new Date().toISOString();
    if (!await this.repository.updateRangeInstanceDnsState(id, hostKey, instanceId, claimId, state)) throw new ConflictException('核验过程中实例发生变化，结果未覆盖当前状态。');
    return { status: state.status, action: configure ? 'apply-dns' : 'verify-dns', dnsVerification: publicDnsVerification({ [hostKey]: state })![hostKey] };
  }
  protected pause(milliseconds: number) { return new Promise<void>(resolve => setTimeout(resolve, milliseconds)); }
}
