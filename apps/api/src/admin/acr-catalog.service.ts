import { ForbiddenException, Injectable } from '@nestjs/common';
import { getCurrentCloudWorkspaceScope } from '../auth/cloud-workspace-scope';
import { buildAcrMatchIndex, readAcrInventory, type AcrInventory } from './aliyun-acr-catalog';
import { SystemConfigService } from './system-config.service';

type Catalog = {
  state: 'idle' | 'running' | 'ready' | 'failed';
  error: string | null;
  snapshot?: AcrInventory;
  syncedAt: string | null;
  match?: ReturnType<typeof buildAcrMatchIndex>;
};

@Injectable()
export class AcrCatalogService {
  private readonly catalogs = new Map<string, Catalog>();

  constructor(private readonly config: SystemConfigService) {}

  private workspace() {
    const scope = getCurrentCloudWorkspaceScope();
    if (!scope || 'system' in scope || scope.provider !== 'alibaba_cloud' || !scope.accountUid || scope.isReadOnly) return null;
    return { key: `${scope.cloudWorkspaceId}:${scope.accountUid}`, accountUid: scope.accountUid };
  }

  private authorizedWorkspace() {
    const workspace = this.workspace();
    if (!workspace) throw new ForbiddenException('请切换到已绑定的阿里云工作空间。');
    return workspace;
  }

  matcher() {
    const workspace = this.workspace();
    return workspace ? this.catalogs.get(workspace.key)?.match : undefined;
  }

  list(page = 1, pageSize = 20, search = '') {
    const { key } = this.authorizedWorkspace();
    const catalog = this.catalogs.get(key);
    const keyword = search.trim().toLowerCase();
    const all = catalog?.snapshot?.items ?? [];
    const items = keyword ? all.filter(item =>
      [item.repository, item.tag, item.region, item.instance, item.digest, ...item.domains].some(value => value?.toLowerCase().includes(keyword))) : all;
    const current = Math.min(page, Math.max(1, Math.ceil(items.length / pageSize)));
    return {
      state: catalog?.state ?? 'idle', error: catalog?.error ?? null, syncedAt: catalog?.syncedAt ?? null,
      regionCount: catalog?.snapshot?.regionCount ?? 0, instanceCount: catalog?.snapshot?.instanceCount ?? 0,
      repositoryCount: catalog?.snapshot?.repositoryCount ?? 0, imageCount: all.length,
      total: items.length, page: current, pageSize, items: items.slice((current - 1) * pageSize, current * pageSize),
    };
  }

  async start() {
    const { key, accountUid } = this.authorizedWorkspace();
    if (this.catalogs.get(key)?.state === 'running') return { state: 'running' as const };
    const credentials = await this.config.getSelectedAccountContext();
    if (credentials.provider !== 'alibaba_cloud' || !credentials.accountUidResolved || credentials.accountUid !== accountUid ||
        !credentials.accessKeyId || !credentials.accessKeySecret) throw new ForbiddenException('当前工作空间的阿里云账号未核验。');
    if (this.catalogs.get(key)?.state === 'running') return { state: 'running' as const };
    const catalog: Catalog = { syncedAt: null, ...this.catalogs.get(key), state: 'running', error: null };
    this.catalogs.set(key, catalog);
    void readAcrInventory(credentials).then(snapshot => {
      const match = buildAcrMatchIndex(snapshot.items);
      Object.assign(catalog, { snapshot, match, state: 'ready', syncedAt: new Date().toISOString() });
    }).catch(error => {
      catalog.state = 'failed';
      catalog.error = error instanceof Error ? error.message : '未能同步 ACR 镜像目录。';
    });
    return { state: 'running' as const };
  }
}
