import { AsyncLocalStorage } from 'node:async_hooks';

export type CloudWorkspaceProvider = 'alibaba_cloud' | 'tencent_cloud';

export type CloudWorkspaceScope = {
  cloudWorkspaceId: string;
  provider: CloudWorkspaceProvider;
  accountUid: string | null;
  isReadOnly?: boolean;
  actorUserId?: string;
  isPlatformManager?: boolean;
  cloudAccountContextId?: string;
};

export type SystemCloudWorkspaceScope = { system: true };

const storage = new AsyncLocalStorage<CloudWorkspaceScope | SystemCloudWorkspaceScope>();

function runScoped<T>(scope: CloudWorkspaceScope | SystemCloudWorkspaceScope, work: () => T): T {
  return storage.run(scope, () => {
    const result = work();
    // Prisma promises execute lazily: assimilate them before leaving the request scope.
    return result && typeof (result as any).then === 'function' ? Promise.resolve(result) as T : result;
  });
}

export function runInCloudWorkspace<T>(scope: CloudWorkspaceScope, work: () => T): T {
  if (!scope.cloudWorkspaceId.trim() || !['alibaba_cloud', 'tencent_cloud'].includes(scope.provider)) {
    throw new Error('A verified cloud workspace is required');
  }
  return runScoped(Object.freeze({ ...scope }), work);
}

export function runInSystemCloudWorkspaceScope<T>(work: () => T): T {
  return runScoped({ system: true }, work);
}

export function getCurrentCloudWorkspaceScope(): CloudWorkspaceScope | SystemCloudWorkspaceScope | null {
  return storage.getStore() ?? null;
}

export function getCurrentCloudWorkspaceId(): string | null {
  const scope = storage.getStore();
  return scope && !('system' in scope) ? scope.cloudWorkspaceId : null;
}

export function requireCurrentCloudWorkspaceId(): string {
  const id = getCurrentCloudWorkspaceId();
  if (!id) throw new Error('Cloud workspace scope is missing');
  return id;
}
