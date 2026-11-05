// Run beside an isolated web container using --network container:<test-web>. All APIs are synthetic.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright-core');
const base = new URL(process.env.RANGE_BATCH_TEST_URL || 'http://127.0.0.1:3000');
assert.equal(base.hostname, '127.0.0.1', 'Only the isolated web container loopback is allowed');
const artifacts = process.env.RANGE_BATCH_TEST_ARTIFACTS || '/artifacts';
fs.mkdirSync(artifacts, { recursive: true });
const profile = { id: 'ui-admin', username: 'ui-admin', role: 'admin', isPlatformManager: true };
const cloud = { id: 'ui-context', provider: 'alibaba_cloud', cloudWorkspaceId: 'ui-workspace', accountUid: '123456',
  regionId: 'cn-beijing', zoneId: 'cn-beijing-h', status: 'ready', isActive: true, imageImportBucket: '' };
const workspace = { id: 'ui-workspace', provider: cloud.provider, accountUid: cloud.accountUid, displayName: '隔离验证账号', isReadOnly: false,
  activeCloudAccountContextId: cloud.id, contexts: [cloud], capabilities: { provisioning: true, rangeProvisioning: true, imageImport: true, billingSync: true } };
function fixtures() {
  return Array.from({ length: 21 }, (_, group) => Array.from({ length: 3 }, (_, index) => ({ id: `ui-range-${group}-${index + 1}`,
    name: `批次-${group}-${index + 1}`, ownerUserId: profile.id, createdBy: profile.username, templateId: 'ui-template', templateNameSnapshot: '综合靶场测试拓扑',
    createdAt: '2026-10-20T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z', status: 'running', dnatPublicIp: `198.51.100.${index + 1}`,
    launchBatch: { id: `ui-batch-${group}`, name: `批次-${group}`, index: index + 1, quantity: 3 } }))).flat();
}
function detail(instance) {
  return { ...instance, accessEntry: { publicIp: instance.dnatPublicIp },
    runtimeTopologyGraph: { schemaVersion: '1', nodes: [{ id: 'ui-host', kind: 'ecs', label: '多网卡测试主机', imageName: '测试镜像',
      nics: [{ privateIp: '172.16.10.10' }, { privateIp: '172.16.20.10' }] }], edges: [] },
    runtimeCredentials: { 'ui-host': { username: 'not-for-default-export', password: 'fixture-secret-never-default' } } };
}
(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const reports = [];
  try {
    for (const width of [1440, 1024, 390]) {
      console.log(`Checking batch UX at ${width}px`);
      const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block', acceptDownloads: true });
      const instances = fixtures(), writes = [], errors = []; let accessReads = 0;
      await context.addInitScript(profile => {
        localStorage.setItem('aliyun-cyber-range-admin-session', JSON.stringify({ token: 'offline-range-batch-test', profile }));
        localStorage.setItem('admin-page-size', '20');
      }, profile);
      await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin === base.origin && !url.pathname.startsWith('/api/')) return route.continue();
        const path = url.pathname.replace(/^\/api/, '');
        const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type, x-cloud-workspace-id, x-idempotency-key',
          'access-control-allow-methods': 'GET, OPTIONS, POST' };
        if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
        const send = json => route.fulfill({ json, headers });
        if (request.method() !== 'GET') {
          const match = /^\/admin\/ranges\/(ui-range-0-[123])\/(destroy|retry)$/.exec(path);
          if (request.method() === 'POST' && match) {
            assert(request.headers()['x-idempotency-key']); writes.push(match[1]);
            if (match[1] === 'ui-range-0-1') return route.fulfill({ status: 503, json: { message: 'synthetic unknown intake' }, headers });
            instances.find(instance => instance.id === match[1]).status = 'pending_destroy';
            return send({ id: `ui-job-${match[1]}`, rangeInstanceId: match[1], status: 'pending', jobType: match[2] });
          }
          errors.push(`Unexpected write: ${request.method()} ${path}`); return route.abort();
        }
        if (path === '/admin/session') return send(profile);
        if (path === '/admin/cloud-workspaces/current') return send(workspace);
        if (path === '/admin/cloud-workspaces') return send([workspace]);
        if (path === '/admin/cloud-contexts') return send([cloud]);
        if (path === '/admin/provision-jobs') return send([]);
        if (path === '/admin/ranges') return send(instances);
        const match = /^\/admin\/ranges\/(ui-range-\d+-\d+)(\/access)?$/.exec(path);
        if (match) {
          const instance = instances.find(instance => instance.id === match[1]); assert(instance);
          if (match[2]) { accessReads++; return send({ id: instance.id, runtimeCredentials: { 'ui-host': { username: 'Administrator', password: 'fixture-sensitive-export' } } }); }
          return send(detail(instance));
        }
        errors.push(`Unmocked API: ${path}`); return route.abort();
      });
      const page = await context.newPage(); page.setDefaultTimeout(20000); page.setDefaultNavigationTimeout(20000);
      page.on('pageerror', error => errors.push(error.message));
      try {
        await page.goto(new URL('/admin/ranges', base).href);
        await page.getByRole('button', { name: '展开批次 批次-0', exact: true }).waitFor();
        assert.equal(await page.getByRole('button', { name: /^展开批次/ }).count(), 20);
        await page.getByRole('link', { name: '第 2 页', exact: true }).click();
        await page.getByRole('button', { name: '展开批次 批次-20', exact: true }).click();
        for (const index of [1, 2, 3]) await page.getByText(`批次-20-${index}`, { exact: true }).waitFor();
        assert.equal(await page.getByRole('button', { name: /^(展开|收起)批次/ }).count(), 1);
        await page.getByRole('link', { name: '第 1 页', exact: true }).click();
        reports.push({ width, check: 'group-pagination', passed: true });
        const table = page.getByRole('table', { name: '编排实例列表' });
        const owner = page.locator('.admin-paginated-list-body');
        await owner.evaluate(element => { element.scrollTop = 240; });
        await page.evaluate(() => new Promise(requestAnimationFrame));
        const headerBox = await table.locator('thead').boundingBox(), ownerBox = await owner.boundingBox();
        assert(Math.abs(headerBox.y - ownerBox.y) < 3, 'Grouped table header scrolls away');
        if (width === 390) {
          await owner.evaluate(element => { element.scrollLeft = 180; });
          const aligned = await table.evaluate(element => [...element.querySelectorAll('thead th')].filter(cell => cell.getBoundingClientRect().width)
            .every((cell, index) => Math.abs(cell.getBoundingClientRect().x - [...element.querySelector('tbody tr').children].filter(cell => cell.getBoundingClientRect().width)[index].getBoundingClientRect().x) < 2));
          assert(aligned, 'Horizontal scrolling misaligns columns');
        }
        await owner.evaluate(element => { element.scrollTop = 0; element.scrollLeft = 0; });
        await page.getByRole('button', { name: '展开批次 批次-0', exact: true }).click();
        await page.screenshot({ path: `${artifacts}/range-batches-${width}.png` });
        reports.push({ width, check: 'sticky-and-expand', passed: true });
        await page.getByRole('searchbox', { name: '筛选实例名' }).fill('批次-0-2');
        assert.equal(await page.locator('table tbody tr').count(), 4);
        reports.push({ width, check: 'member-search-preserves-batch', passed: true });
        await page.getByRole('button', { name: '关闭批次 批次-0', exact: true }).click();
        const close = page.getByRole('dialog', { name: '关闭整批编排实例', exact: true });
        assert.equal(await close.getByRole('listitem').count(), 3); assert.equal(writes.length, 0);
        if (width === 1440) await page.screenshot({ path: `${artifacts}/range-batch-close-confirmation.png` });
        await close.getByRole('button', { name: '确认关闭整批', exact: true }).click();
        await close.waitFor({ state: 'hidden' });
        await page.getByRole('alert').filter({ hasText: '1 套结果待确认' }).waitFor();
        assert.deepEqual(writes, ['ui-range-0-1', 'ui-range-0-2', 'ui-range-0-3']);
        assert(await page.getByRole('button', { name: '关闭批次 批次-0', exact: true }).isDisabled());
        reports.push({ width, check: 'confirmed-partial-close-no-duplicate', passed: true });
        await page.getByRole('button', { name: '导出批次 批次-0', exact: true }).click();
        const exportDialog = page.getByRole('dialog', { name: '导出靶场信息', exact: true });
        assert.equal(await exportDialog.getByRole('checkbox').getAttribute('aria-checked'), 'false');
        if (width === 1440) await page.screenshot({ path: `${artifacts}/range-batch-export-dialog.png` });
        const downloaded = page.waitForEvent('download');
        await exportDialog.getByRole('button', { name: '导出 CSV', exact: true }).click();
        const download = await downloaded, csv = fs.readFileSync(await download.path(), 'utf8');
        assert.equal(accessReads, 0); assert(!csv.includes('密码') && !csv.includes('fixture-secret'));
        for (const value of ['批次-0-1', '批次-0-2', '批次-0-3', '172.16.10.10', '172.16.20.10']) assert(csv.includes(value));
        reports.push({ width, check: 'default-export-no-credentials', passed: true });
        if (width === 1440) {
          await page.getByRole('button', { name: '导出批次 批次-0', exact: true }).click();
          await exportDialog.getByRole('checkbox').check();
          const sensitiveDownloaded = page.waitForEvent('download');
          await exportDialog.getByRole('button', { name: '导出 CSV', exact: true }).click();
          const sensitive = fs.readFileSync(await (await sensitiveDownloaded).path(), 'utf8');
          assert.equal(accessReads, 3); assert(sensitive.includes('fixture-sensitive-export'));
          reports.push({ width, check: 'explicit-sensitive-export', passed: true });
        }
        assert.deepEqual(errors, []);
      } catch (error) {
        await page.screenshot({ path: `${artifacts}/failure-${width}.png` }).catch(() => {});
        if (errors.length) console.error(JSON.stringify(errors)); throw error;
      } finally { await context.close(); }
    }
    console.log(JSON.stringify({ cases: reports.length, passed: reports, productionApiRequests: 0 }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
