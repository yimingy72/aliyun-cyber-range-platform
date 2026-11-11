import { readFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { join } from 'node:path';

const assetRoot = join(__dirname, '../../../infra/keycloak/themes/cyber-range/login/resources');
const assetUrl = '/mcp/oauth/ui/';
const assets = new Map([
  ['css/styles.css', 'text/css; charset=utf-8'],
  ['js/platform-theme.js', 'text/javascript; charset=utf-8'],
  ['img/platform-mark.svg', 'image/svg+xml'],
  ['img/platform-mark-cel.svg', 'image/svg+xml'],
  ['img/platform-favicon.svg', 'image/svg+xml'],
].map(([name, type]) => [name, { type, bytes: readFileSync(join(assetRoot, name)) }] as const));

export function serveOAuthPageAsset(res: ServerResponse, pathname: string) {
  if (!pathname.startsWith(assetUrl)) return false;
  const asset = assets.get(pathname.slice(assetUrl.length));
  if (!asset) return false;
  res.writeHead(200, {
    'Content-Type': asset.type, 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff',
  });
  res.end(asset.bytes);
  return true;
}

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function render(res: ServerResponse, title: string, body: string, form: boolean, refresh = '') {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Referrer-Policy': form ? 'same-origin' : 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self'; " +
      `form-action ${form ? "'self'" : "'none'"}; frame-ancestors 'none'; base-uri 'none'`,
  });
  res.end(`<!doctype html><html lang="zh-CN" class="login-pf" data-platform-theme="cel">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title><link rel="icon" type="image/svg+xml" href="${assetUrl}img/platform-favicon.svg">
<script src="${assetUrl}js/platform-theme.js?v=1"></script>
<link rel="stylesheet" href="${assetUrl}css/styles.css?v=4">${refresh}</head>
<body><div class="cr-login-shell cr-oauth-shell"><div class="cr-login-wrap">
<main class="cr-login-card"><header class="cr-login-copy"><div class="cr-login-title-row">
<img alt="" class="cr-login-title-mark" width="31" height="31" src="${assetUrl}img/platform-mark.svg">
<h1 class="cr-login-title">${title}</h1></div></header>
<div class="cr-login-body cr-oauth-body">${body}</div></main></div></div></body></html>`);
}

export function consent(res: ServerResponse, handle: string, scopes?: string[]) {
  const description = scopes ? '申请范围：' + scopes.join('、') : '允许工具使用你在靶场角色范围内的功能。';
  render(res, '授权工具访问靶场', `<p class="cr-login-subtitle">${escapeHtml(description)}</p>
<form class="cr-oauth-actions" method="post" action="/mcp/oauth/approve">
<input type="hidden" name="handle" value="${escapeHtml(handle)}">
<button class="cr-login-button" type="submit" name="decision" value="yes">授权</button>
<button class="cr-login-button cr-oauth-deny" type="submit" name="decision" value="no">拒绝</button></form>`, true);
}

export function returnToAgent(res: ServerResponse, url: URL) {
  // Chrome blocks a cross-origin 3xx after the consent form POST under form-action.
  const href = escapeHtml(url.href);
  render(res, '返回工具', `<p class="cr-login-subtitle">若未自动返回，请点击下方按钮。</p>
<a class="cr-login-button" rel="noreferrer" href="${href}">返回工具</a>`, false,
  `<meta http-equiv="refresh" content="0;url=${href}">`);
}
