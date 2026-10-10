import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAdminSession, writeAdminSession } from './admin-auth-storage';
import { setCloudWorkspaceSelection, workspaceStorageKey } from './cloud-workspace-selection';
import { completeImageImport, deleteCloudAccount, fetchCloudWorkspaces, fetchPlatformImages, saveCloudAccount, switchCloudWorkspace } from './admin-api';

describe('workspace-scoped Web API and local drafts', () => {
  beforeEach(() => { window.localStorage.clear(); window.sessionStorage.clear(); clearAdminSession(); writeAdminSession({ token: 'token', profile: { id: 'root', username: 'admin', role: 'admin' } }); setCloudWorkspaceSelection('root', 'ali'); });
  it('uses the selected workspace on business calls but leaves discovery metadata unscoped', async () => {
    const request = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ items: [] }))); vi.stubGlobal('fetch', request);
    await fetchPlatformImages('https://fixture.invalid', 'token', 'platform');
    expect(request.mock.calls[0]![1].headers['x-cloud-workspace-id']).toBe('ali');
    await fetchCloudWorkspaces('https://fixture.invalid', 'token');
    expect(request.mock.calls[1]![1].headers['x-cloud-workspace-id']).toBeUndefined();
  });
  it('freezes the import completion scope after an account switch', async () => {
    const request = vi.fn().mockImplementation(async () => new Response('{}')); vi.stubGlobal('fetch', request);
    setCloudWorkspaceSelection('root', 'tencent'); await completeImageImport('https://fixture.invalid', 'token', 'old-job', 'ali');
    expect(request.mock.calls[0]![1].headers['x-cloud-workspace-id']).toBe('ali');
  });
  it('namespaces drafts by both identity and workspace and does not mix an existing edit target with the selected account', async () => {
    const first = workspaceStorageKey('template-editor:new-template');
    setCloudWorkspaceSelection('root', 'tencent'); const second = workspaceStorageKey('template-editor:new-template');
    expect(first).not.toBe(second); expect(second).toContain('root:tencent');
    const request = vi.fn().mockImplementation(async () => new Response('{}')); vi.stubGlobal('fetch', request);
    await saveCloudAccount('https://fixture.invalid', 'token', { provider: 'alibaba_cloud', cloudWorkspaceId: 'ali', regionId: 'cn-hangzhou', zoneId: 'cn-hangzhou-h', accessKeyId: 'fixture-id', accessKeySecret: 'fixture-secret' });
    expect(JSON.parse(request.mock.calls[0]![1].body).cloudWorkspaceId).toBe('ali');
    await switchCloudWorkspace('https://fixture.invalid', 'token', 'ali');
    expect(request.mock.calls[1]![0]).toBe('https://fixture.invalid/admin/cloud-workspaces/ali/switch');
  });
  it('deletes the explicit account binding without changing the current request scope', async () => {
    const request = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ id: 'other/account', retainedData: true })));
    vi.stubGlobal('fetch', request);
    await deleteCloudAccount('https://fixture.invalid', 'token', 'other/account');
    expect(request.mock.calls[0]![0]).toBe('https://fixture.invalid/admin/cloud-workspaces/other%2Faccount');
    expect(request.mock.calls[0]![1].method).toBe('DELETE');
    expect(request.mock.calls[0]![1].headers['x-cloud-workspace-id']).toBe('ali');
  });
});
