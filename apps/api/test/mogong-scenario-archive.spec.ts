import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScenariosController } from '../src/admin/scenarios.controller';
import type { AuthenticatedPlatformRequest } from '../src/auth/request-auth-context';

it('lists only summaries and restricts original configurations to the migration owner and workspace', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mogong-archive-'));
  const path = join(dir, 'archive.json');
  const before = process.env.MOGONG_SCENARIO_ARCHIVE_PATH;
  process.env.MOGONG_SCENARIO_ARCHIVE_PATH = path;
  try {
    const summary = { id: 7, name: 'Test scene', creator: 'Source author', active: true, nodeCount: 1, templateId: null, reasons: ['Needs image'] };
    const source = { network_config: { nodes: [{ id: 'original-node' }], edges: [] } };
    await writeFile(path, JSON.stringify({ workspaceId: 'workspace-a', ownerUserId: 'owner', capturedAt: '2026-01-01', items: [{ summary, source }] }));
    const request = (id: string, cloudWorkspaceId?: string, role = 'admin') => ({
      adminUser: { id, role }, authContext: { cloudWorkspaceId },
    }) as AuthenticatedPlatformRequest;
    const controller = new ScenariosController(undefined!, undefined!);
    await expect(controller.listMogongArchive(request('owner', 'workspace-a'))).resolves.toEqual({ capturedAt: '2026-01-01', items: [summary] });
    await expect(controller.getMogongArchiveItem(request('owner', 'workspace-a'), 7)).resolves.toEqual(source);
    await expect(controller.getMogongArchiveItem(request('owner', 'workspace-b'), 7)).rejects.toMatchObject({ status: 404 });
    await expect(controller.listMogongArchive(request('other', 'workspace-a'))).rejects.toMatchObject({ status: 404 });
    await expect(controller.listMogongArchive(request('owner', 'workspace-a', 'user'))).rejects.toMatchObject({ status: 404 });
    await expect(controller.listMogongArchive(request('owner'))).rejects.toMatchObject({ status: 404 });
  } finally {
    if (before === undefined) delete process.env.MOGONG_SCENARIO_ARCHIVE_PATH;
    else process.env.MOGONG_SCENARIO_ARCHIVE_PATH = before;
    await rm(dir, { recursive: true, force: true });
  }
});
