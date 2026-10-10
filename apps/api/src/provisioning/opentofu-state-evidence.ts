import fs from 'node:fs/promises';
import path from 'node:path';

export const APPLY_PENDING_FILE = '.range-apply-started';
const APPLY_COMPLETE_FILE = '.range-apply-complete.json';
const RECOVERY_REQUIRED = 'OpenTofu state recovery is required before proceeding; persisted workspace was preserved';

type StateInstance = { address: string; type: string; module?: string; attributes: Record<string, unknown>; tainted: boolean };
export type WorkspaceState = { lineage: string; serial: number; instances: StateInstance[] };
export type ApplyEvidence = { submittedAt?: string; sourceProvisionJobId?: string; version: 1; addresses: string[]; createAddresses: string[]; priorLineage: string | null; priorSerial?: number | null; priorIds: Record<string, string> };

export async function fileExists(file: string) {
  try { await fs.stat(file); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function readWorkspaceState(dir: string, requireState = false): Promise<WorkspaceState | null> {
  if (await fileExists(path.join(dir, 'errored.tfstate'))) throw new Error(RECOVERY_REQUIRED);
  const statePath = path.join(dir, 'terraform.tfstate');
  if (!(await fileExists(statePath))) {
    if (requireState || await fileExists(path.join(dir, 'terraform.tfstate.backup')) ||
        await fileExists(path.join(dir, APPLY_PENDING_FILE)) || await fileExists(path.join(dir, APPLY_COMPLETE_FILE))) {
      throw new Error(RECOVERY_REQUIRED);
    }
    return null;
  }
  try {
    const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    if (state?.version !== 4 || typeof state.lineage !== 'string' || !state.lineage ||
        !Number.isSafeInteger(state.serial) || state.serial < 0 || !Array.isArray(state.resources)) throw new Error();
    const instances: StateInstance[] = [];
    for (const resource of state.resources) {
      if (!resource || !['managed', 'data'].includes(resource.mode) || typeof resource.type !== 'string' ||
          typeof resource.name !== 'string' || !Array.isArray(resource.instances) ||
          (resource.module !== undefined && typeof resource.module !== 'string')) throw new Error();
      if (resource.mode !== 'managed') continue;
      for (const instance of resource.instances) {
        const a = instance?.attributes;
        if (!a || typeof a !== 'object' || Array.isArray(a) || typeof a.id !== 'string' || !a.id.trim()) throw new Error();
        if (instance.index_key !== undefined && typeof instance.index_key !== 'string' && !Number.isSafeInteger(instance.index_key)) throw new Error();
        instances.push({
          address: `${resource.module ? `${resource.module}.` : ''}${resource.type}.${resource.name}${instance.index_key === undefined ? '' : `[${JSON.stringify(instance.index_key)}]`}`,
          type: resource.type, module: resource.module, attributes: a,
          tainted: Boolean(instance.deposed) || (instance.status !== undefined && instance.status !== 'ready'),
        });
      }
    }
    return { lineage: state.lineage, serial: state.serial, instances };
  } catch { throw new Error(RECOVERY_REQUIRED); }
}

async function readEvidence(dir: string, file = APPLY_PENDING_FILE): Promise<ApplyEvidence | null | 'unknown'> {
  if (!(await fileExists(path.join(dir, file)))) return null;
  try {
    const value = JSON.parse(await fs.readFile(path.join(dir, file), 'utf8'));
    if (value?.version !== 1 || !Array.isArray(value.addresses) || !value.addresses.length ||
        !Array.isArray(value.createAddresses) || !value.addresses.every((x: unknown) => typeof x === 'string' && x.length > 0) ||
        !value.createAddresses.every((x: unknown) => typeof x === 'string' && value.addresses.includes(x)) ||
        new Set(value.addresses).size !== value.addresses.length ||
        !value.priorIds || typeof value.priorIds !== 'object' || Array.isArray(value.priorIds) ||
        !Object.entries(value.priorIds).every(([key, id]) => value.createAddresses.includes(key) && typeof id === 'string' && id.length > 0) ||
        !(value.priorLineage === null || typeof value.priorLineage === 'string' && Boolean(value.priorLineage.trim()))
        || value.priorSerial !== undefined && value.priorSerial !== null && (!Number.isSafeInteger(value.priorSerial) || value.priorSerial < 0 || value.priorLineage === null)) return 'unknown';
    return value;
  } catch { return 'unknown'; }
}

function stateCoversPlan(state: WorkspaceState | null, evidence: ApplyEvidence) {
  const addresses = state?.instances.map(instance => instance.address) ?? [];
  return Boolean(state && (!evidence.priorLineage || evidence.priorLineage === state.lineage) &&
    (evidence.priorSerial == null || state.serial >= evidence.priorSerial) &&
    !state.instances.some(instance => instance.tainted) && new Set(addresses).size === addresses.length &&
    evidence.addresses.length === addresses.length && evidence.addresses.every(address => addresses.includes(address)) &&
    Object.entries(evidence.priorIds).every(([address, id]) => state.instances.find(instance => instance.address === address)?.attributes.id !== id));
}

export async function hasUnresolvedApply(dir: string, state: WorkspaceState | null) {
  const pending = await readEvidence(dir);
  return pending === 'unknown' || Boolean(pending && !stateCoversPlan(state, pending));
}

export function assertPendingApplyAncestor(state: WorkspaceState, evidence: ApplyEvidence | null) {
  if (evidence && (evidence.priorLineage !== null && evidence.priorLineage !== state.lineage
    || evidence.priorSerial != null && state.serial < evidence.priorSerial))
    throw new Error('OpenTofu pending apply ancestor state does not match; recovery is required');
}

export async function assertWorkspaceCanApply(dir: string, requireState = false) {
  const state = await readWorkspaceState(dir, requireState);
  if (await hasUnresolvedApply(dir, state) || (requireState && !state?.instances.length)) throw new Error(RECOVERY_REQUIRED);
  const complete = await readEvidence(dir, APPLY_COMPLETE_FILE);
  if (!(await fileExists(path.join(dir, APPLY_PENDING_FILE))) &&
      (complete === 'unknown' || (complete && !stateCoversPlan(state, complete)))) throw new Error(RECOVERY_REQUIRED);
  return state;
}

export async function recordApplyPlan(dir: string, plan: unknown, sourceProvisionJobId?: string) {
  const value = plan as any;
  const addresses: string[] = [];
  const collect = (module: any) => {
    if (!module || typeof module !== 'object') throw new Error('OpenTofu plan resource graph is missing');
    for (const resource of module.resources ?? []) {
      if (resource.mode === 'managed') {
        if (typeof resource.address !== 'string' || !resource.address) throw new Error('OpenTofu plan resource address is missing');
        addresses.push(resource.address);
      }
    }
    for (const child of module.child_modules ?? []) collect(child);
  };
  collect(value?.planned_values?.root_module);
  if (!addresses.length || new Set(addresses).size !== addresses.length || value.errored || value.complete === false)
    throw new Error('OpenTofu plan is incomplete; apply was not started');
  const createAddresses: string[] = [];
  for (const resource of value.resource_changes ?? []) {
    if (resource.mode === 'managed' && resource.change?.actions?.includes('create')) {
      if (!addresses.includes(resource.address)) throw new Error('OpenTofu plan create address is outside the resource graph');
      createAddresses.push(resource.address);
    }
  }
  const state = await assertWorkspaceCanApply(dir);
  const priorIds = Object.fromEntries((state?.instances ?? []).filter(instance => createAddresses.includes(instance.address)).map(instance => [instance.address, instance.attributes.id as string]));
  const evidence: ApplyEvidence = { submittedAt: new Date().toISOString(), ...(sourceProvisionJobId ? { sourceProvisionJobId } : {}), version: 1, addresses, createAddresses, priorLineage: state?.lineage ?? null, priorSerial: state?.serial ?? null, priorIds };
  await fs.writeFile(path.join(dir, APPLY_PENDING_FILE), JSON.stringify(evidence), { mode: 0o600 });
}

export async function completeApply(dir: string) {
  const state = await readWorkspaceState(dir, true);
  const pending = await readEvidence(dir);
  if (!pending || pending === 'unknown' || !stateCoversPlan(state, pending)) throw new Error(RECOVERY_REQUIRED);
  await fs.writeFile(path.join(dir, APPLY_COMPLETE_FILE), JSON.stringify({ ...pending, priorLineage: state!.lineage, priorSerial: state!.serial }), { mode: 0o600 });
  await fs.rm(path.join(dir, APPLY_PENDING_FILE));
}

export async function assertDestroyComplete(dir: string, previous: WorkspaceState, unresolvedApply: boolean) {
  const state = await readWorkspaceState(dir, true);
  if (state!.lineage !== previous.lineage || state!.serial < previous.serial || state!.instances.length)
    throw new Error('OpenTofu destroy did not leave a verified empty state; recovery is required');
  if (unresolvedApply) throw new Error('OpenTofu tracked resources were cleaned, but the previous apply outcome is unknown; cloud resource recovery is required');
  await fs.rm(path.join(dir, APPLY_PENDING_FILE), { force: true });
  // Only a verified empty state with no unresolved apply ends this generation.
  // The worker still requires cloud absence verification before allowing create.
  await fs.rm(path.join(dir, APPLY_COMPLETE_FILE), { force: true });
}

export async function readPendingApplyEvidence(dir: string) {
  const value = await readEvidence(dir);
  if (value === 'unknown') throw new Error('OpenTofu pending creation evidence is malformed');
  return value;
}
