// Read-only visual regression against an isolated web container. Every API request is mocked.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright-core');
const fixture = require('./check-sticky-table-headers.cjs');
const { base, artifacts, profile, indexes, images, cloudSnapshot, scrollCheck } = fixture;
let provider = 'alibaba_cloud';
const snapshots = indexes.map(i => ({ ...cloudSnapshot, id: `ui-snapshot-${i}`, imageId: `m-ui-${i}`, sourceImageName: `布局测试云镜像-${i}` }));
function payload(url) {
  const path = url.pathname.replace(/^\/api/, '');
  if (provider === 'tencent_cloud') {
    const context = { ...fixture.cloud, provider, regionId: 'ap-beijing', zoneId: 'ap-beijing-3' };
    const workspace = { ...fixture.workspace, provider, contexts: [context] };
    if (path === '/admin/cloud-workspaces/current') return workspace;
    if (path === '/admin/cloud-workspaces') return [workspace];
    if (path === '/admin/cloud-contexts') return [context];
    if (path === '/admin/platform-images') return { items: images.map(image => ({ ...image, provider })) };
    if (path.startsWith('/admin/tencent-cloud/contexts/')) return { provider, cloudAccountContextId: context.id, accountUid: workspace.accountUid, regionId: context.regionId, zoneId: context.zoneId, scope: url.searchParams.get('scope'), offset: Number(url.searchParams.get('offset')), limit: Number(url.searchParams.get('limit')), items: snapshots.map(s => ({ imageId: s.imageId, displayName: s.sourceImageName, platform: s.platform, isAvailable: true, status: 'NORMAL' })), totalCount: snapshots.length };
  }
  if (path === '/admin/instances') {
    const rows = fixture.payload(url);
    if (url.searchParams.get('view') === 'history') rows.standaloneInstances = rows.standaloneInstances.map(row => ({ ...row, status: 'destroyed' }));
    return rows;
  }
  if (path === '/admin/platform-container-images') return { items: [] };
  if (path === '/admin/image-catalog/mogong') return { capturedAt: '2026-11-05T00:00:00Z', total: indexes.length, containersCollectable: true, syncAllowed: true,
    items: indexes.map(i => ({ id: i + 1, name: `布局墨攻镜像-${i}`, type: 'vm', imageId: `m-ui-${i}`, active: true, status: 'successful', creator: profile.username })) };
  if (path === '/admin/image-catalog/acr') return { state: 'ready', syncedAt: '2026-11-05T00:00:00Z', page: 1, pageSize: 20, total: indexes.length,
    items: indexes.slice(0, 20).map(i => ({ id: `acr-${i}`, repository: `training/network-lab-${i}`, tag: 'v1', instance: 'ACR-layout', region: 'cn-beijing', domains: ['registry.cn-beijing.example.com'], status: 'NORMAL' })) };
  if (path === '/admin/image-catalog/custom' || path === '/admin/image-catalog/public') return { snapshots: snapshots.map(snapshot => ({ ...snapshot, provider, regionId: provider === 'tencent_cloud' ? 'ap-beijing' : snapshot.regionId })), catalogItems: [] };
  if (path === '/admin/billing/entries') return { version: 2, startAt: '2026-10-01', endAt: '2026-11-05', mode: 'resource', page: 1, pageSize: 20, total: indexes.length,
    items: indexes.slice(0, 20).map(i => ({ id: `single:${i}`, kind: 'single', name: `布局账目-${i}`, ownerUserId: profile.id, ownerUsername: profile.username, createdAt: '2026-11-05T00:00:00Z', instanceStatus: 'running', lifecycleStatus: 'active', reconciliationStatus: 'current', billingStatus: 'issued', amounts: [{ currency: 'CNY', pretaxAmount: i + 0.125 }], resourceCount: 1, pendingResourceCount: 0 })), currencyTotals: [], filteredAmounts: [], pendingResourceCount: 0, queryStatus: { queuedCount: 0, runningCount: 0 } };
  return fixture.payload(url);
}
const cases = [
  { id: 'templates', path: '/admin/scenarios' },
  { id: 'ranges', path: '/admin/ranges' },
  { id: 'range-history', path: '/admin/ranges?view=history' },
  { id: 'instances', path: '/admin/instances' },
  { id: 'instance-history', path: '/admin/instances?view=history' },
  { id: 'users', path: '/admin/users' },
  { id: 'image-platform', path: '/admin/image-center' },
  { id: 'image-mine', path: '/admin/image-center', tab: '我的镜像' },
  { id: 'image-mogong', path: '/admin/image-center', tab: '墨攻镜像中心' },
  { id: 'image-custom', path: '/admin/image-center', tab: '云上镜像来源' },
  { id: 'image-public', path: '/admin/image-center', tab: '云上镜像来源', scope: '阿里云公共镜像' },
  { id: 'image-acr', path: '/admin/image-center', tab: '云上镜像来源', scope: 'ACR 容器镜像' },
  { id: 'billing', path: '/admin/billing' },
  { id: 'alerts', path: '/admin/billing', alerts: true },
  { id: 'settings', path: '/admin/settings/cloud' },
  { id: 'range-nodes', path: '/admin/ranges/ui-range-0' },
  { id: 'tencent-platform', path: '/admin/image-center', tencent: true },
  { id: 'tencent-mine', path: '/admin/image-center', tencent: true, tab: '我的镜像' },
  { id: 'tencent-cloud', path: '/admin/image-center', tencent: true, tab: '云上镜像来源' },
];
(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const errors = [], reports = [];
  try {
    const context = await browser.newContext({ reducedMotion: 'reduce', serviceWorkers: 'block' });
    await context.addInitScript(({ profile }) => localStorage.setItem('aliyun-cyber-range-admin-session', JSON.stringify({ token: 'offline-layout-test', profile })), { profile });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin === base.origin && !url.pathname.startsWith('/api/')) return route.continue();
      const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type, x-cloud-workspace-id', 'access-control-allow-methods': 'GET, OPTIONS' };
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      if (request.method() !== 'GET') { errors.push(`Unexpected write ${request.method()} ${url.pathname}`); return route.abort(); }
      try { return route.fulfill({ json: payload(url), headers }); }
      catch (error) { errors.push(error.message); return route.abort(); }
    });
    const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
    for (const width of [1720, 1440, 1024, 390]) {
      await page.setViewportSize({ width, height: 960 });
      for (const test of cases) {
        provider = test.tencent ? 'tencent_cloud' : 'alibaba_cloud';
        console.log(`Checking ${test.id} at ${width}px`);
        await page.goto(new URL(test.path, base).href);
        if (test.tab) await page.getByRole('tab', { name: test.tab, exact: true }).click();
        if (test.scope) {
          await page.getByRole('combobox', { name: '云上镜像来源切换' }).click();
          await page.getByRole('option', { name: test.scope, exact: true }).click();
        }
        if (test.alerts) await page.getByRole('button', { name: '资源告警', exact: true }).click();
        const table = page.locator('table:visible').first(); await table.waitFor();
        await page.waitForFunction(() => [...document.querySelectorAll('table')].some(t => t.getBoundingClientRect().width > 0 && t.tBodies[0]?.rows.length > 10)).catch(async error => { await page.screenshot({ path: `${artifacts}/columns-failure.png` }); fs.writeFileSync(`${artifacts}/browser-errors.json`, JSON.stringify(errors)); throw error; });
        const columns = await table.evaluate(table => {
          const heads = [...table.querySelectorAll('thead th')], cells = [...table.querySelector('tbody tr').children];
          return { heads: heads.map(h => ({ id: h.dataset.columnId, label: h.textContent, width: h.getBoundingClientRect().width })),
            cells: cells.map(c => ({ id: c.dataset.columnId, text: c.textContent })), overflow: document.documentElement.scrollWidth > innerWidth + 2 };
        });
        assert.deepEqual(columns.heads.map(h => h.id), columns.cells.map(c => c.id), `${test.id}: header/data mismatch`);
        assert(!columns.overflow, `${test.id}: page overflows at ${width}`);
        const creator = columns.heads.findIndex(h => h.label === '创建人');
        if (creator >= 0) {
          const action = columns.heads.findIndex(h => h.label === '操作');
          assert.equal(creator, action < 0 ? columns.heads.length - 1 : action - 1, `${test.id}: creator placement`);
          assert(columns.cells[creator].text.includes(profile.username), `${test.id}: wrong value in creator column`);
          if (columns.heads[creator].width) assert(Math.abs(columns.heads[creator].width - 112) < 1, `${test.id}: creator width`);
        }
        await scrollCheck(page, table);
        if (width === 1720) { await page.evaluate(() => document.fonts.ready); await page.screenshot({ path: `${artifacts}/columns-${test.id}.png` }); }
        reports.push({ id: test.id, width, columns: columns.heads });
      }
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(`${artifacts}/columns-report.json`, JSON.stringify(reports, null, 2));
    console.log(`Passed ${reports.length} page/width checks with read-only fixtures.`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
