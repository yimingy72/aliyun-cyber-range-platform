import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImageCatalogController } from '../src/admin/image-catalog.controller';
import { runInCloudWorkspace } from '../src/auth/cloud-workspace-scope';

const scope = { cloudWorkspaceId: 'mogong-space', provider: 'alibaba_cloud' as const, accountUid: '123' };
const controller = new ImageCatalogController({ listCustom: async () => ({ snapshots: [] }) } as never, {} as never, {} as never);
const fixture = { id: 1, name: '源目录镜像', type: 'vm', imageId: 'm-fixture', active: true,
  status: 'successful', creator: null, containerReference: null };
const original = JSON.stringify({ version: 2, capturedAt: '2026-10-28T00:00:00Z', total: 1, items: [fixture] });
let dir: string;
let path: string;
let server: Server | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mogong-sync-'));
  path = join(dir, 'catalog.json');
  process.env.MOGONG_IMAGE_CATALOG_PATH = path;
  process.env.MOGONG_CATALOG_WORKSPACE_ID = scope.cloudWorkspaceId;
  await writeFile(path, original);
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close((err) => err ? reject(err) : resolve()));
  server = undefined;
  delete process.env.MOGONG_IMAGE_CATALOG_PATH;
  delete process.env.MOGONG_CATALOG_WORKSPACE_ID;
  await rm(dir, { recursive: true, force: true });
});

function connect(status: number, payload: string) {
  const request = jest.fn();
  server = createServer((req, res) => {
    request(req.method, req.url);
    res.writeHead(status).end(payload);
  });
  return new Promise<typeof request>((resolve) => server!.listen(join(dir, 'sync.sock'), () => resolve(request)));
}

it('updates the visible list once for concurrent sync requests and limits sync to its workspace', async () => {
  const capturedAt = new Date().toISOString();
  const request = await connect(200, JSON.stringify({ version: 2, capturedAt, total: 1,
    items: [{ ...fixture, id: 2, name: '新墨攻镜像', extra: 'must not be stored' }] }));
  expect(() => runInCloudWorkspace({ ...scope, cloudWorkspaceId: 'other' }, () => controller.syncMogong())).toThrow('当前工作空间未绑定');
  const results = await runInCloudWorkspace(scope, () => Promise.all([controller.syncMogong(), controller.syncMogong()]));
  expect(results).toEqual([{ capturedAt, total: 1 }, { capturedAt, total: 1 }]);
  expect(request.mock.calls).toEqual([['POST', '/snapshot']]);
  expect((await runInCloudWorkspace(scope, () => controller.listMogong())).items.map(item => item.name)).toEqual(['新墨攻镜像']);
  expect(await readFile(path, 'utf8')).not.toContain('must not be stored');
});

it.each([['invalid snapshot', 200, '{"total":2,"items":[]}'], ['source failure', 503, '']])(
  'keeps the previous snapshot on %s',
  async (_label, status, payload) => {
    await connect(status, payload);
    await expect(runInCloudWorkspace(scope, () => controller.syncMogong())).rejects.toMatchObject({ status: 503 });
    expect(await readFile(path, 'utf8')).toBe(original);
  },
);
