import { randomUUID } from 'node:crypto';
import { signAliyunRpcQuery } from './image-catalog-rpc-signer';

type Row = Record<string, unknown>;
type Credentials = { accessKeyId: string; accessKeySecret: string; defaultRegion: string };
type Query = (region: string, action: string, params?: Record<string, string>) => Promise<Row>;
export type AcrImage = {
  id: string; region: string; instance: string; repository: string; tag: string;
  digest: string | null; domains: string[]; status: string; updatedAt: string | null;
};
export type AcrMatch = 'matched' | 'candidate' | 'ambiguous' | 'unmatched' | 'not_checked';
export type AcrInventory = { items: AcrImage[]; regionCount: number; instanceCount: number; repositoryCount: number };

const actions: Record<string, string> = {
  ListInstance: 'cr:ListInstance', ListInstanceEndpoint: 'cr:ListInstanceEndpoint',
  ListRepository: 'cr:ListRepository', ListRepoTag: 'cr:ListRepositoryTag',
};
const regionPattern = /^[a-z]{2}(?:-[a-z0-9]+)+$/;
const pathSegment = /^[a-z0-9]+(?:[._-]+[a-z0-9]+)*$/;
const tagPattern = /^[\w][\w.-]{0,127}$/;
const hostPattern = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?::\d{1,5})?$/;

function field(row: Row, key: string, format: RegExp) {
  const value = row[key];
  if (typeof value !== 'string' || value.length > 253 || !format.test(value)) throw Error('ACR 返回的目录字段不完整。');
  return value;
}

function rows(body: Row, key: string, allowEmpty = false): Row[] {
  const value = body[key];
  if (allowEmpty && value == null) return [];
  if (!Array.isArray(value) || value.some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
    throw Error('ACR 返回的目录列表不完整。');
  }
  return value as Row[];
}

function distinct<T>(items: T[], key: (item: T) => string) {
  if (new Set(items.map(key)).size !== items.length) throw Error('ACR 返回了重复目录项，请重新同步。');
  return items;
}

function rpc(credentials: Credentials): Query {
  return async (region, action, params = {}) => {
    const query = signAliyunRpcQuery({
      Action: action, Version: '2018-12-01', RegionId: region, Format: 'JSON',
      AccessKeyId: credentials.accessKeyId, SignatureNonce: randomUUID(), SignatureMethod: 'HMAC-SHA1',
      SignatureVersion: '1.0', Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), ...params,
    }, credentials.accessKeySecret);
    for (let attempt = 0; ; attempt++) {
      let response: Response, body: Row;
      try {
        response = await fetch(`https://cr.${region}.aliyuncs.com/?${query}`, { redirect: 'error', signal: AbortSignal.timeout(12_000) });
        body = await response.json() as Row;
      } catch {
        throw Error(`未能读取 ACR 目录（${region}，${action}）。`);
      }
      if (response.ok && body?.IsSuccess === true && body.Code === 'success') return body;
      if ((response.status === 429 || /throttl/i.test(String(body?.Code))) && attempt < 2) {
        await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 1100));
        continue;
      }
      if ([401, 403].includes(response.status) || /AUTHENTICATION_FAILED|NoPrivilege|Forbidden|AccessDenied/i.test(String(body?.Code))) {
        throw Error(`阿里云拒绝读取 ACR（${region}，${actions[action] ?? action}）。请检查当前云账号的 ACR 只读权限。`);
      }
      throw Error(`ACR 目录读取失败（${region}，${action}）。`);
    }
  };
}

async function pages(query: Query, region: string, action: string, key: string, params: Record<string, string> = {}) {
  const output: Row[] = [];
  const size = 100;
  let total: number | undefined;
  for (let page = 1; ; page++) {
    const body = await query(region, action, { ...params, PageNo: String(page), PageSize: String(size) });
    const count = body.TotalCount;
    if ((typeof count !== 'number' && !(typeof count === 'string' && /^\d+$/.test(count))) ||
        !Number.isSafeInteger(Number(count)) || Number(count) < 0 || Number(count) > 100_000 ||
        (total !== undefined && Number(count) !== total) ||
        (body.PageNo !== undefined && Number(body.PageNo) !== page)) throw Error('ACR 目录分页不完整，请重新同步。');
    total = Number(count);
    const batch = rows(body, key, total === 0);
    if (batch.length !== Math.min(size, total - output.length)) throw Error('ACR 目录分页不完整，请重新同步。');
    output.push(...batch);
    if (output.length === total) return output;
  }
}

async function mapLimit<T, R>(items: T[], call: (item: T) => Promise<R>): Promise<R[]> {
  const result: R[] = [];
  let next = 0;
  let stopped = false;
  await Promise.all(Array.from({ length: Math.min(6, items.length) }, async () => {
    try {
      while (!stopped && next < items.length) {
        const i = next++;
        result[i] = await call(items[i]);
      }
    } catch (error) { stopped = true; throw error; }
  }));
  return result;
}

export async function readAcrInventory(credentials: Credentials, query: Query = rpc(credentials)): Promise<AcrInventory> {
  const home = regionPattern.test(credentials.defaultRegion) ? credentials.defaultRegion : 'cn-hangzhou';
  const regions = distinct(rows(await query(home, 'ListInstanceRegion'), 'Regions')
    .map(row => field(row, 'RegionId', regionPattern)), x => x);
  if (!regions.length || regions.length > 80) throw Error('ACR 未返回有效的地域列表。');
  const first = regions.includes(home) ? home : regions[0];
  const listInstances = async (region: string) => distinct((await pages(query, region, 'ListInstance', 'Instances')).map(row => {
    if (row.RegionId !== undefined && row.RegionId !== region) throw Error('ACR 返回了其他地域的实例。');
    return { region, id: field(row, 'InstanceId', /^cri-[a-z0-9]+$/), name: field(row, 'InstanceName', /^[\w. -]+$/) };
  }), row => row.id);
  const firstInstances = await listInstances(first);
  const instances = [...firstInstances, ...(await mapLimit(regions.filter(region => region !== first), listInstances)).flat()];
  const repos = (await mapLimit(instances, async instance => {
    const { id, region } = instance;
    const endpointResponse = await query(region, 'ListInstanceEndpoint', { InstanceId: id, ModuleName: 'Registry', Summary: 'true' });
    const domains = [...new Set(rows(endpointResponse, 'Endpoints').flatMap(endpoint =>
      rows(endpoint, 'Domains', true).map(domain => field(domain, 'Domain', hostPattern).toLowerCase())))];
    return distinct((await pages(query, region, 'ListRepository', 'Repositories', { InstanceId: id })).map(row => {
      if (row.InstanceId !== undefined && row.InstanceId !== id) throw Error('ACR 返回了其他实例的仓库。');
      return { instance, domains, repoId: field(row, 'RepoId', /^crr-[a-z0-9]+$/),
        repository: `${field(row, 'RepoNamespaceName', pathSegment)}/${field(row, 'RepoName', pathSegment)}` };
    }), repo => repo.repoId);
  })).flat();
  const items = (await mapLimit(repos, async ({ instance, domains, repoId, repository }) =>
    distinct((await pages(query, instance.region, 'ListRepoTag', 'Images', { InstanceId: instance.id, RepoId: repoId })).map(row => {
      const tag = field(row, 'Tag', tagPattern);
      const digest = typeof row.Digest === 'string' ? row.Digest.replace(/^sha256:/i, '').toLowerCase() : '';
      const millis = Number(row.ImageUpdate);
      return { id: `${instance.region}/${instance.id}/${repoId}:${tag}`, region: instance.region, instance: instance.name, repository, tag,
        digest: /^[a-f0-9]{64}$/.test(digest) ? `sha256:${digest}` : null, domains,
        status: field(row, 'Status', /^[A-Za-z_]+$/), updatedAt: Number.isSafeInteger(millis) && millis > 0 && millis < 8.64e15 ? new Date(millis).toISOString() : null };
    }), item => item.id))).flat();
  return { items, regionCount: regions.length, instanceCount: instances.length, repositoryCount: repos.length };
}

export function buildAcrMatchIndex(items: AcrImage[]) {
  const exact = new Map<string, Set<string>>();
  const names = new Map<string, Set<string>>();
  function add(index: Map<string, Set<string>>, key: string, id: string) {
    const ids = index.get(key) ?? new Set<string>();
    ids.add(id);
    index.set(key, ids);
  }
  for (const image of items) {
    if (image.status !== 'NORMAL') continue;
    const repoIdentity = image.id.slice(0, image.id.lastIndexOf(':'));
    for (const host of image.domains) {
      const path = `${host}/${image.repository}`;
      add(exact, `${path}:${image.tag}`, image.id);
      if (image.digest) add(exact, `${path}@${image.digest}`, repoIdentity);
    }
    add(names, `${image.repository}:${image.tag}`, image.id);
    add(names, `${image.repository.split('/').at(-1)}:${image.tag}`, image.id);
  }
  return (reference: string | null): AcrMatch => {
    if (!reference) return 'unmatched';
    const segments = reference.trim().split('/');
    const hasHost = segments.length >= 3 && hostPattern.test(segments[0].toLowerCase());
    const matches = hasHost
      ? exact.get([segments[0].toLowerCase(), ...segments.slice(1)].join('/'))
      : names.get(reference.trim());
    if (!matches?.size) return 'unmatched';
    if (matches.size > 1) return 'ambiguous';
    return hasHost ? 'matched' : 'candidate';
  };
}
