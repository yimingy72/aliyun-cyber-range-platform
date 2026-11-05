// Offline UI regression: every business request is mocked; never connect to production APIs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright-core');
const base = new URL(process.env.IMAGE_CENTER_TEST_URL || 'http://web-image-center-ui:3000');
assert(['web-image-center-ui', '127.0.0.1'].includes(base.hostname), 'An isolated web container is required');
const artifacts = process.env.IMAGE_CENTER_TEST_ARTIFACTS || '/artifacts';
fs.mkdirSync(artifacts, { recursive: true });
const profile = { id: 'ui-admin', username: 'ui-admin', role: 'admin', isPlatformManager: true };
const cloud = { id: 'ui-context', cloudWorkspaceId: 'ui-workspace', provider: 'alibaba_cloud', accountUid: '123456',
  displayName: '测试账号', regionId: 'cn-beijing', zoneId: 'cn-beijing-h', status: 'ready', isActive: true, imageImportBucket: '', bucketStatus: 'unconfigured' };
const workspace = { id: 'ui-workspace', provider: 'alibaba_cloud', accountUid: '123456', displayName: '测试空间', isReadOnly: false,
  activeCloudAccountContextId: cloud.id, contexts: [cloud], capabilities: { provisioning: true, rangeProvisioning: true, imageImport: true, billingSync: true } };
const image = { id: 'ui-image', imageId: 'm-ui-image', displayName: '布局验证镜像', provider: 'alibaba_cloud', accountUid: '123456',
  accountScopeKey: '123456', regionId: cloud.regionId, ownerUserId: profile.id, createdBy: profile.username, canManage: true,
  visibility: 'platform', sourceScope: 'custom', sourceSnapshotAvailable: true, sourceSnapshotStatus: 'Available', enabled: true, tags: [] };
const tags = [{ id: 'ui-tag', name: '基础镜像' }];
const snapshot = scope => ({ id: `ui-${scope}`, provider: 'alibaba_cloud', accountUid: '123456', accountScopeKey: '123456',
  regionId: cloud.regionId, scope, imageId: `m-ui-${scope}`, sourceImageName: scope === 'custom' ? '云上自定义验证镜像' : '云上公共验证镜像',
  platform: 'Ubuntu', status: 'Available', isAvailable: true });
const message = 'Admin API request failed with status 502';

(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const errors = [], reports = [];
  let metadataReads = 0, tagWrites = 0, metadataFailure = true;
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await context.addInitScript(profile => {
      localStorage.setItem('aliyun-cyber-range-admin-session', JSON.stringify({ token: 'offline-image-center-test', profile }));
    }, profile);
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin === base.origin && !url.pathname.startsWith('/api/')) return route.continue();
      const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type, x-cloud-workspace-id, x-idempotency-key',
        'access-control-allow-methods': 'GET, OPTIONS, PUT' };
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      const path = url.pathname.replace(/^\/api/, '');
      if (request.method() === 'PUT' && path === '/admin/platform-images/ui-image/tags') {
        tagWrites++;
        return route.fulfill({ status: 502, body: '', headers });
      }
      if (request.method() !== 'GET') { errors.push(`Unexpected write: ${request.method()} ${path}`); return route.abort(); }
      let json;
      if (path === '/admin/session') json = profile;
      else if (path === '/admin/cloud-workspaces/current') json = workspace;
      else if (path === '/admin/cloud-workspaces') json = [workspace];
      else if (path === '/admin/cloud-contexts') {
        metadataReads++;
        if (metadataFailure) { metadataFailure = false; return route.fulfill({ status: 502, body: '', headers }); }
        json = [cloud];
      } else if (path === '/admin/platform-images') json = { items: [image] };
      else if (path === '/admin/platform-image-tags') json = { items: tags };
      else if (path === '/admin/image-imports') json = { items: [] };
      else if (path === '/admin/image-catalog/custom') json = { snapshots: [snapshot('custom')], catalogItems: [] };
      else if (path === '/admin/image-catalog/public') json = { snapshots: [snapshot('public')], catalogItems: [] };
      else if (path === '/admin/scenarios' || path === '/admin/provision-jobs') json = [];
      else { errors.push(`Unmocked API: ${path}`); return route.abort(); }
      return route.fulfill({ json, headers });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message));
    async function revisit() {
      await page.getByRole('link', { name: /靶场编排/ }).click();
      await page.getByRole('link', { name: /镜像中心/ }).click();
      await page.getByRole('table', { name: '平台镜像', exact: true }).waitFor();
    }
    await page.goto(new URL('/admin/image-center', base).href);
    await page.getByText(message, { exact: true }).waitFor();
    await revisit();
    await page.getByText(message, { exact: true }).waitFor({ state: 'hidden' });
    assert.equal(metadataReads, 2, 'Reopening did not reread failed metadata');
    const row = page.getByRole('row').filter({ hasText: image.displayName });
    await row.getByRole('button', { name: `编辑标签 ${image.displayName}` }).click();
    await page.getByRole('menuitemcheckbox', { name: tags[0].name }).click();
    await page.getByRole('alert').filter({ hasText: message }).first().waitFor();
    await page.keyboard.press('Escape');
    await revisit();
    await page.getByText(message, { exact: true }).waitFor({ state: 'hidden' });
    assert.equal(tagWrites, 1, 'A failed write was replayed on navigation');
    reports.push({ recoveredMetadata502: true, clearedOldWrite502: true, writeReplayCount: 0 });

    for (const width of [1440, 1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.getByRole('tab', { name: '云上镜像来源', exact: true }).click();
      const picker = page.getByRole('combobox', { name: '云上镜像来源切换' });
      const search = page.getByRole('searchbox', { name: '筛选镜像名' });
      const [pickBox, searchBox] = await Promise.all([picker.boundingBox(), search.boundingBox()]);
      assert(pickBox && searchBox);
      if (width >= 1280) assert(Math.abs(pickBox.y - searchBox.y) < 2 && Math.abs(pickBox.height - searchBox.height) < 2, 'Source filter is not aligned with search');
      assert.equal(await page.getByRole('tabpanel').count(), 1, 'The extra cloud tab panel remains');
      await picker.click();
      await page.getByRole('option', { name: '阿里云自定义镜像', exact: true }).waitFor();
      await page.getByRole('option', { name: '阿里云公共镜像', exact: true }).waitFor();
      await page.screenshot({ path: `${artifacts}/image-center-source-${width}.png` });
      await page.getByRole('option', { name: '阿里云公共镜像', exact: true }).click();
      await page.getByRole('table', { name: '阿里云公共镜像', exact: true }).getByText('云上公共验证镜像', { exact: true }).waitFor();
      await picker.click();
      await page.getByRole('option', { name: '阿里云自定义镜像', exact: true }).click();
      await page.getByRole('table', { name: '阿里云自定义镜像', exact: true }).getByText('云上自定义验证镜像', { exact: true }).waitFor();
      assert(await picker.evaluate(element => { const box = element.getBoundingClientRect(); return box.x >= 0 && box.right <= innerWidth; }), 'Source selector overflows the viewport');
      reports.push({ width, sourceSelector: true, aligned: width >= 1280, publicAndCustomSwitch: true });
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ reports, consoleErrors: errors, mockedWrites: tagWrites, externalRequests: 0 }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
