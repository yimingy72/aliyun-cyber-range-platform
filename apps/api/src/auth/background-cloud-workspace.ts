import { getCurrentCloudWorkspaceScope, type CloudWorkspaceProvider } from './cloud-workspace-scope';

export type ExecutionCloudWorkspace = { id: string; provider: CloudWorkspaceProvider; accountUid: string | null; isReadOnly: boolean };
type WorkspaceRunner = {
  runInWorkspace<T>(id: string | null | undefined, work: () => Promise<T>): Promise<T>;
  listExecutionCloudWorkspaces(): Promise<ExecutionCloudWorkspace[]>;
};

export async function runInExecutionCloudWorkspace<T>(service: unknown, id: string | null | undefined,
  work: () => Promise<T>, source?: { provider?: string; accountUid?: string | null }): Promise<T> {
  if (!id && process.env.NODE_ENV === 'test') return work();
  const runner = service as Partial<WorkspaceRunner> | undefined;
  if (typeof runner?.runInWorkspace !== 'function') {
    if (process.env.NODE_ENV === 'test') return work();
    throw new Error('Background execution requires a verified cloud workspace runner');
  }
  return runner.runInWorkspace(id, async () => {
    const scope = getCurrentCloudWorkspaceScope();
    if (!scope || 'system' in scope || scope.cloudWorkspaceId !== id || scope.isReadOnly || !['alibaba_cloud', 'tencent_cloud'].includes(scope.provider)
      || source?.provider && scope.provider !== source.provider
      || source?.accountUid && scope.accountUid !== source.accountUid) {
      throw new Error('Background execution does not match its frozen cloud workspace and account');
    }
    return work();
  });
}

export async function listExecutionCloudWorkspaces(service: unknown): Promise<ExecutionCloudWorkspace[] | null> {
  const runner = service as Partial<WorkspaceRunner> | undefined;
  if (typeof runner?.listExecutionCloudWorkspaces !== 'function') {
    if (process.env.NODE_ENV === 'test') return null;
    throw new Error('Background polling requires verified cloud workspaces');
  }
  return (await runner.listExecutionCloudWorkspaces()).filter(space => ['alibaba_cloud', 'tencent_cloud'].includes(space.provider) && Boolean(space.accountUid) && !space.isReadOnly);
}
