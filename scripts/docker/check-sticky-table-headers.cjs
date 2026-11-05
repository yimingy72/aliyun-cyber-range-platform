// Offline browser regression. Run only against an isolated web container, never production APIs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright-core');
const base = new URL(process.env.HEADER_TEST_URL || 'http://web-header-ui:3000');
assert(['web-header-ui', '127.0.0.1'].includes(base.hostname), 'An isolated web URL is required');
const artifacts = process.env.HEADER_TEST_ARTIFACTS || '/artifacts';
fs.mkdirSync(artifacts, { recursive: true });
const profile = { id: 'ui-admin', username: 'ui-admin', role: 'admin', isPlatformManager: true };
const time = '2026-10-20T03:34:00Z';
const cloud = { id: 'ui-context', cloudWorkspaceId: 'ui-workspace', provider: 'alibaba_cloud', accountUid: '123456',
  displayName: '布局测试账号', regionId: 'cn-beijing', zoneId: 'cn-beijing-h', status: 'ready', isActive: true, imageImportBucket: '' };
const workspace = { id: 'ui-workspace', provider: 'alibaba_cloud', accountUid: '123456', displayName: '布局测试空间', isReadOnly: false,
  activeCloudAccountContextId: cloud.id, contexts: [cloud], capabilities: { provisioning: true, rangeProvisioning: true, imageImport: true, billingSync: true } };
const indexes = Array.from({ length: 60 }, (_, index) => index);
const ranges = indexes.map(index => ({ id: `ui-range-${index}`, name: `布局实例-${String(index).padStart(2, '0')}`,
  createdBy: profile.username, ownerUserId: profile.id, canManage: true, status: 'running', instanceMode: 'range',
  templateId: `ui-template-${index}`, templateNameSnapshot: '综合靶场布局测试', createdAt: time, expiresAt: '2099-01-01T00:00:00Z',
  dnatPublicIp: `198.51.100.${index + 1}`, resourceSummary: { mode: 'opentofu', hostIds: {} } }));
const templates = indexes.map(index => ({ id: `ui-template-${index}`, name: `布局拓扑-${index}`, slug: `ui-template-${index}`, revision: 1,
  ownerUserId: profile.id, createdBy: profile.username, canManage: true, status: 'published', visibility: 'platform',
  topologyGraph: { schemaVersion: '2.0.0', nodes: [], edges: [] }, topologySpec: { networkZones: [], hosts: [] } }));
const users = indexes.map(index => ({ id: `ui-user-${index}`, username: `布局用户-${index}`, role: 'user', status: 'active', createdAt: time, updatedAt: time }));
const images = indexes.map(index => ({ id: `ui-image-${index}`, imageId: `m-ui-${index}`, displayName: `布局镜像-${index}`,
  provider: 'alibaba_cloud', accountUid: '123456', accountScopeKey: '123456', regionId: 'cn-beijing', ownerUserId: profile.id,
  createdBy: profile.username, canManage: true, visibility: 'platform', sourceScope: 'custom', sourceSnapshotAvailable: true, enabled: true, tags: [] }));
const tags = [{ id: 'ui-tag', name: '布局测试标签' }];
const cloudSnapshot = { id: 'ui-snapshot-new', provider: 'alibaba_cloud', accountUid: '123456', accountScopeKey: '123456',
  regionId: 'cn-beijing', scope: 'custom', imageId: 'm-ui-new', sourceImageName: '布局测试云镜像', status: 'Available', isAvailable: true, platform: 'Ubuntu' };
const resources = Array.from({ length: 281 }, (_, index) => ({ resourceKey: `ledger:ui-${index}`, ledgerId: `ui-ledger-${index}`,
  cloudWorkspaceId: workspace.id, cloudProvider: 'alibaba_cloud', cloudAccountUid: '123456', regionId: 'cn-beijing',
  cloudResourceType: 'eip', cloudResourceId: `eip-ui-${index}`, ownerUserId: 'ui-user-0', rangeInstanceId: `ui-range-${index}`,
  sourceProvisionJobId: `ui-job-${index}`, billingStartAt: time, releasedAt: time, proofFailureReason: 'BILL_DETAILS_PENDING' }));
const detail = { ...ranges[0], accessEntry: { publicIp: '198.51.100.1' }, resourceSummary: { mode: 'opentofu',
  hostIds: Object.fromEntries(indexes.map(index => [`host-${index}`, `i-ui-${index}`])), cloudReleaseDeadlines: {},
  dnatEntryIds: {}, snatEntryIds: {} }, runtimeTopologyGraph: { schemaVersion: '1',
  nodes: indexes.map(index => ({ id: `host-${index}`, kind: 'ecs', data: { label: `布局节点-${index}` } })), edges: [] } };
function paged(url, total, create) {
  const page = Number(url.searchParams.get('page') || 1), pageSize = Number(url.searchParams.get('pageSize') || 20);
  assert(Number.isInteger(page) && page >= 1 && page <= Math.max(1, Math.ceil(total / pageSize)), 'Out-of-range API page');
  return { page, pageSize, total, items: Array.from({ length: Math.min(pageSize, total - (page - 1) * pageSize) }, (_, index) => create((page - 1) * pageSize + index)) };
}
function payload(url) {
  const path = url.pathname.replace(/^\/api/, '');
  if (path === '/admin/session') return profile;
  if (path === '/admin/cloud-workspaces/current') return workspace;
  if (path === '/admin/cloud-workspaces') return [workspace, ...indexes.slice(1).map(index => ({ ...workspace, id: `ui-workspace-${index}`, displayName: `布局账号-${index}` }))];
  if (path === '/admin/cloud-contexts') return [cloud];
  if (path === '/admin/ranges/ui-range-0') return detail;
  if (path === '/admin/ranges') return url.searchParams.get('view') === 'history' ? ranges.map(row => ({ ...row, status: 'destroyed' })) : ranges;
  if (path === '/admin/instances') return { batches: [], standaloneInstances: ranges.map(row => ({ ...row, instanceMode: 'single', templateId: null, singleInstanceConfig: { cpu: 2, memory: 4 } })) };
  if (path === '/admin/provision-jobs') return [];
  if (path === '/admin/scenarios') return templates;
  if (path === '/admin/users') return users;
  if (path === '/admin/platform-images') return { items: images };
  if (path === '/admin/platform-image-tags') return { items: tags };
  if (path === '/admin/image-imports') return { items: [] };
  if (path.startsWith('/admin/image-catalog/')) return { snapshots: [cloudSnapshot], catalogItems: [] };
  if (path === '/admin/system-config/instance-type-availability') return { cpu: 2, memory: 4, regionId: cloud.regionId,
    zoneId: cloud.zoneId, exactAvailable: true, matches: [], warning: null };
  if (path === '/admin/system-config') return { fields: [], sources: {}, contexts: [cloud] };
  if (path === '/admin/resource-alerts/patrol') return { status: 'ready', managerUserId: profile.id, managerUsername: profile.username, regions: ['cn-beijing'], lastScanAt: time, lastScanError: null };
  if (path === '/admin/resource-alerts') return indexes.map(index => ({ id: `ui-alert-${index}`, cloudWorkspaceId: workspace.id, provider: workspace.provider,
    status: 'pending', type: 'ecs', resourceId: `i-ui-${index}`,
    accountUid: '123456', regionId: 'cn-beijing', reason: '布局测试告警', firstSeenAt: time, lastSeenAt: time,
    evidenceSummary: { recordedInventory: true, sourceJobIds: [], accountVerified: true }, remainingResources: [] }));
  if (path === '/admin/billing/summary') return { billingScope: 'platform_resources', billingStatus: 'provisional', currency: 'CNY',
    totalPretaxAmount: 168.5, platformPretaxAmount: 0, anomalyCount: 0, currencyTotals: [], unallocatedCurrencyTotals: [],
    resourcesWithoutBillCount: resources.length, resourcesWithoutBill: resources, reconciliationIssues: [], dailyTotals: [], resourceTypeTotals: [] };
  if (path === '/admin/billing/users') return paged(url, 101, index => ({ userId: `ui-user-${index}`, username: `账单用户-${index}`, pretaxAmount: 1, currency: 'CNY', itemCount: 1, launchCount: 1 }));
  if (path === '/admin/billing/user-groups' || path === '/admin/billing/platform/groups') return paged(url, 45, index => ({ id: `ui-group-${index}`, title: `测试费用组-${index}`,
    kind: 'range_launch', resourceCount: 1, pretaxAmount: 1, currency: 'CNY', items: [], completedAt: time, billingPeriodStart: '2026-10-01', billingPeriodEnd: '2026-10-20' }));
  throw Error(`Unmocked API: ${path}`);
}
async function scrollCheck(page, table) {
  const owner = (await table.evaluateHandle(element => {
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY) && parent.scrollHeight > parent.clientHeight + 20) return parent;
    }
    throw Error('No actual vertical scroll owner');
  })).asElement();
  const header = table.locator('thead');
  await owner.evaluate(element => { element.scrollTop = Math.min(240, element.scrollHeight - element.clientHeight); });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const [head, box] = await Promise.all([header.boundingBox(), owner.boundingBox()]);
  assert(head && box && Math.abs(head.y - box.y) <= 3, `Header moved with rows: head=${head?.y}, scroll=${box?.y}`);
  const geometry = await table.evaluate(element => {
    const heads = [...element.querySelectorAll('thead th')].filter(cell => cell.getBoundingClientRect().width > 0);
    const cells = [...element.querySelector('tbody tr').children].filter(cell => cell.getBoundingClientRect().width > 0);
    return heads.map((cell, index) => Math.abs(cell.getBoundingClientRect().x - cells[index].getBoundingClientRect().x));
  });
  assert(geometry.every(delta => delta < 2), 'Header/body columns are misaligned');
  if (await owner.evaluate(element => element.scrollWidth > element.clientWidth + 30)) {
    const before = await header.boundingBox();
    await owner.evaluate(element => { element.scrollLeft = 100; });
    await page.evaluate(() => new Promise(requestAnimationFrame));
    const after = await header.boundingBox();
    assert(Math.abs(before.y - after.y) < 2 && after.x < before.x - 50, 'Horizontal scroll broke header synchronization');
  }
  return owner;
}
async function revealFooter(page, footer) {
  await footer.evaluate(element => {
    const outer = element.closest('.admin-main-content');
    if (outer) outer.scrollTop += element.getBoundingClientRect().bottom - outer.getBoundingClientRect().bottom + 20;
  });
  await page.evaluate(() => new Promise(requestAnimationFrame));
  assert(await footer.evaluate(element => {
    const box = element.getBoundingClientRect();
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(parent).overflowY)) {
        const clip = parent.getBoundingClientRect();
        if (box.top < clip.top - 1 || box.bottom > clip.bottom + 1) return false;
      }
    }
    return true;
  }), 'Pagination is clipped by an ancestor and cannot be reached by page scrolling');
}
(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const errors = [], reports = [], mockWrites = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await context.addInitScript(({ profile }) => {
      localStorage.setItem('aliyun-cyber-range-admin-session', JSON.stringify({ token: 'offline-layout-test', profile }));
      localStorage.setItem('admin-page-size', '20');
    }, { profile });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin === base.origin && !url.pathname.startsWith('/api/')) return route.continue();
      const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type, x-cloud-workspace-id, x-idempotency-key',
        'access-control-allow-methods': 'GET, OPTIONS, POST, PUT' };
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      // This fixture exercises the legacy billing fallback; current billing has a separate browser check.
      if (request.method() === 'GET' && url.pathname.replace(/^\/api/, '') === '/admin/billing/entries') return route.fulfill({ status: 404, headers, json: {} });
      if (request.method() !== 'GET') {
        const path = url.pathname.replace(/^\/api/, '');
        const body = request.postDataJSON();
        if (request.method() === 'POST' && path === '/admin/platform-images' && body.snapshotId === cloudSnapshot.id) {
          mockWrites.push({ method: 'POST', path, body });
          const asset = { ...images[0], id: 'ui-collected', imageId: cloudSnapshot.imageId, displayName: body.displayName, tags: [] };
          images.unshift(asset); return route.fulfill({ json: asset, headers });
        }
        const match = /^\/admin\/platform-images\/(ui-image-0|ui-collected)\/tags$/.exec(path);
        if (request.method() === 'PUT' && match) {
          mockWrites.push({ method: 'PUT', path, body });
          const asset = images.find(row => row.id === match[1]);
          asset.tags = tags.filter(tag => body.tagIds.includes(tag.id));
          const { sourceSnapshotAvailable: _availability, ...metadata } = asset;
          return route.fulfill({ json: metadata, headers });
        }
        errors.push(`Unexpected write ${request.method()} ${url.pathname}`); return route.abort();
      }
      try { return route.fulfill({ json: payload(url), headers }); } catch (error) { errors.push(error.message); return route.abort(); }
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(15000);
    page.on('pageerror', error => errors.push(error.message));
    const cases = ['/admin/ranges', '/admin/ranges?view=history', '/admin/instances', '/admin/scenarios', '/admin/users', '/admin/image-center', '/admin/billing#resource-alerts', '/admin/settings/cloud', '/admin/ranges/ui-range-0'];
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const path of cases) {
        console.log(`Checking ${path} at ${width}px`);
        await page.goto(new URL(path, base).href);
        if (path.endsWith('#resource-alerts')) await page.getByRole('button', { name: '资源告警', exact: true }).click();
        const table = page.locator('table:visible').first();
        await table.waitFor();
        await page.waitForFunction(() => document.querySelector('table tbody')?.rows.length > 10);
        const owner = await scrollCheck(page, table);
        if (path === '/admin/ranges' && width === 1440) {
          await page.screenshot({ path: `${artifacts}/ranges-scrolled.png` });
          const pagination = page.locator('[data-slot="pagination"]').first();
          await pagination.getByRole('link', { name: '第 2 页' }).click();
          await page.waitForFunction(() => document.querySelector('table tbody')?.textContent.includes('布局实例-20'));
          assert.equal(await owner.evaluate(element => element.scrollTop), 0, 'Page change retained old scroll position');
          const input = page.getByRole('spinbutton', { name: '跳转到页码' });
          await input.fill('99'); await input.press('Enter');
          await page.waitForFunction(() => document.querySelector('[aria-label="第 3 页"]')?.getAttribute('aria-current') === 'page');
          assert.equal(await input.inputValue(), '3');
        }
        if (path.includes('/ui-range-0')) {
          assert(!await page.locator('.range-instance-overview-grid').getByText('云端兜底', { exact: true }).count());
        }
        reports.push({ path, width, sticky: true });
      }
    }
    for (const [width, height] of [[1440, 800], [1280, 800], [1280, 600], [390, 800]]) {
      console.log(`Checking billing at ${width}x${height}`);
      await page.setViewportSize({ width, height });
      await page.goto(new URL('/admin/billing', base).href);
      await page.getByRole('button', { name: '查看待补齐费用明细' }).click();
      const pending = page.getByRole('table', { name: '待补齐资源清单' });
      await scrollCheck(page, pending);
      const detailRegion = page.getByRole('region', { name: '费用明细', exact: true });
      assert((await detailRegion.boundingBox()).height >= 200, 'Expanded pending list crushed the detail region');
      const footer = page.getByLabel('费用明细分页', { exact: true });
      await revealFooter(page, footer);
      assert(await footer.isVisible(), 'Detail pagination is inaccessible');
      if (width === 1440) await page.screenshot({ path: `${artifacts}/billing-expanded-footer.png` });
      const pendingPager = page.getByLabel('待补齐资源清单分页', { exact: true });
      await pendingPager.getByRole('link', { name: '第 2 页' }).click();
      const userPager = page.getByLabel('用户账单分页', { exact: true });
      const jump = userPager.getByRole('spinbutton', { name: '跳转到页码' });
      await jump.fill('99'); await jump.press('Enter');
      await page.getByText('账单用户-100', { exact: true }).waitFor();
      assert.equal(await pendingPager.getByRole('link', { name: '第 2 页' }).getAttribute('aria-current'), 'page', 'User pagination reset independent pending-resource pagination');
      await page.getByRole('button', { name: '收起待补齐费用明细' }).click();
      assert.equal(await pending.count(), 0);
      await revealFooter(page, footer);
      reports.push({ path: '/admin/billing', width, expandedFooterAccessible: true, normalizedServerJump: true });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    console.log('Checking image metadata flow');
    await page.goto(new URL('/admin/image-center', base).href);
    const imageRow = page.getByText('布局镜像-0', { exact: true }).locator('xpath=ancestor::tr');
    await imageRow.getByRole('button', { name: '编辑标签 布局镜像-0' }).click();
    await page.getByRole('menuitemcheckbox', { name: tags[0].name }).click();
    await imageRow.getByText(tags[0].name, { exact: true }).waitFor();
    assert.equal(await imageRow.getByText('来源待确认', { exact: true }).count(), 0);
    await page.keyboard.press('Escape');
    await page.getByRole('tab', { name: '云上镜像来源', exact: true }).click();
    await page.getByRole('button', { name: `收录到平台 ${cloudSnapshot.sourceImageName}` }).click();
    const collectDialog = page.getByRole('dialog', { name: '收录到平台', exact: true });
    await collectDialog.getByLabel('平台镜像名').fill('布局测试收录镜像');
    await collectDialog.getByRole('checkbox', { name: tags[0].name }).check();
    await page.screenshot({ path: `${artifacts}/collect-image-dialog.png` });
    await collectDialog.getByRole('button', { name: '确认收录', exact: true }).click();
    await collectDialog.waitFor({ state: 'hidden' });
    assert.equal(mockWrites.filter(row => row.method === 'POST').length, 1);
    assert.equal(mockWrites.find(row => row.method === 'POST').body.displayName, '布局测试收录镜像');
    assert.deepEqual(mockWrites.at(-1).body.tagIds, ['ui-tag']);
    reports.push({ path: '/admin/image-center', autoSaveTags: true, collectionDialog: true });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ cases: reports.length, passed: reports, simulatedMetadataWrites: mockWrites.length, productionApiRequests: 0 }));
    await context.close();
  } catch (error) {
    if (errors.length) console.error(JSON.stringify(errors));
    const page = browser.contexts()[0]?.pages()[0];
    if (page) await page.screenshot({ path: `${artifacts}/failure.png` }).catch(() => {});
    throw error;
  } finally { await browser.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
