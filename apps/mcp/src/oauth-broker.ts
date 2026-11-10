import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PrismaClient } from '@aliyun-cyber-range/database/generated/client';
import type { McpConfig } from './config';
import { ADMIN_SCOPES } from './auth';

const prefix = '/mcp/oauth/';
const ttl = { registration: 30 * 86400, state: 300, code: 60 };
const supportedScopes = ADMIN_SCOPES.filter(scope => !scope.startsWith('users:'));
const random = () => randomBytes(32).toString('base64url');
const digest = (value: string) => createHash('sha256').update(value).digest('base64url');
const verifierFormat = /^[A-Za-z0-9._~-]{43,128}$/;
const handleFormat = /^[A-Za-z0-9_-]{43}$/;
let database: PrismaClient | undefined;
const records = () => (database ??= new PrismaClient()).mcpOAuthRecord;

type Registration = { redirects: string[] };
type Flow = { client: string; redirect: string; state: string; challenge: string; verifier: string; cookie: string; scope?: string[] };
type TokenSet = { access_token: string; refresh_token?: string; expires_in: number; refresh_expires_in?: number };
type Grant = { client: string; scope?: string[]; sealed: string; accessId?: string };
type Code = Grant & { redirect: string; challenge: string };
type Approval = Code & { state: string; cookie: string };

class OAuthError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code); }
}

function cryptoKey() {
  const key = process.env.OIDC_MCP_BROKER_KEY;
  if (!key || !/^[0-9a-f]{64}$/i.test(key)) throw new OAuthError('temporarily_unavailable', 503);
  return Buffer.from(key, 'hex');
}
function seal(token: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', cryptoKey(), iv);
  return Buffer.concat([iv, cipher.update(token), cipher.final(), cipher.getAuthTag()]).toString('base64url');
}
function open(sealed: string) {
  const bytes = Buffer.from(sealed, 'base64url');
  const cipher = createDecipheriv('aes-256-gcm', cryptoKey(), bytes.subarray(0, 12));
  cipher.setAuthTag(bytes.subarray(-16));
  return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString();
}
async function save(kind: string, payload: object, seconds: number, handle = random()) {
  const id = digest(handle);
  await records().create({ data: { id, kind, payload: JSON.parse(JSON.stringify(payload)), expiresAt: new Date(Date.now() + seconds * 1000) } });
  return handle;
}
async function lookup<T>(kind: string, handle: string) {
  if (!handleFormat.test(handle)) return null;
  const row = await records().findUnique({ where: { id: digest(handle) } });
  return row && row.kind === kind && row.expiresAt > new Date() ? row.payload as T : null;
}
async function consume(kind: string, handle: string) {
  const { count } = await records().deleteMany({ where: { id: digest(handle), kind, expiresAt: { gt: new Date() } } });
  if (count !== 1) throw new OAuthError('invalid_grant');
}

export async function unwrapBrokerAccess(handle: string) {
  const grant = await lookup<Grant>('access', handle);
  return grant ? { token: open(grant.sealed), scope: grant.scope, client: grant.client } : null;
}

export function createOAuthBroker(config: McpConfig) {
  const publicUrl = config.publicUrl ? new URL(config.publicUrl) : null;
  if (!publicUrl) throw new Error('MCP_PUBLIC_URL is required for the OAuth broker');
  const origin = publicUrl.origin;
  const endpoint = process.env.OIDC_TOKEN_ENDPOINT?.trim();
  const issuer = process.env.OIDC_ISSUER?.trim();
  const client = process.env.OIDC_UNIFIED_CLIENT_ID?.trim() || 'cyber-range';
  const secret = process.env.OIDC_UNIFIED_CLIENT_SECRET?.trim();
  if (!endpoint || !issuer || !secret) throw new Error('Keycloak broker authentication is not configured');
  cryptoKey();
  const callback = origin + prefix + 'callback';
  const configuredRedirects = (process.env.OIDC_MCP_ALLOWED_REDIRECTS || '').split(',').map(s => s.trim()).filter(Boolean);
  // Bound the public, unauthenticated entry points even when every request arrives through a reverse proxy.
  const limits = { register: { count: 0, reset: 0, max: 30 }, authorize: { count: 0, reset: 0, max: 90 } };
  const metadata = {
    issuer: origin, authorization_endpoint: origin + prefix + 'authorize',
    token_endpoint: origin + prefix + 'token', registration_endpoint: origin + prefix + 'register',
    response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'],
  };

  async function keycloak(fields: Record<string, string>): Promise<TokenSet> {
    const response = await fetch(endpoint!, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
      body: new URLSearchParams({ ...fields, client_id: client, client_secret: secret! }),
    });
    if (!response.ok) throw new OAuthError(response.status < 500 ? 'invalid_grant' : 'temporarily_unavailable', response.status < 500 ? 400 : 503);
    const token = await response.json();
    if (typeof token.access_token !== 'string' || !Number.isInteger(token.expires_in) || token.expires_in <= 0) {
      throw new OAuthError('temporarily_unavailable', 503);
    }
    return token;
  }

  async function issue(res: ServerResponse, clientId: string, tokens: TokenSet, scope?: string[]) {
    const expires = Math.min(tokens.expires_in, 120);
    const access = await save('access', { client: clientId, scope, sealed: seal(tokens.access_token) }, expires);
    const refreshSeconds = Math.min(tokens.refresh_expires_in || 0, 28800);
    const refresh = tokens.refresh_token && refreshSeconds > 0
      ? await save('refresh', { client: clientId, scope, sealed: seal(tokens.refresh_token), accessId: digest(access) }, refreshSeconds)
      : undefined;
    json(res, 200, { access_token: access, token_type: 'Bearer', expires_in: expires, refresh_token: refresh, scope: scope?.join(' ') });
  }

  return async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url!, origin);
    if (url.pathname !== '/.well-known/oauth-authorization-server' && !url.pathname.startsWith(prefix)) return false;
    try {
      const action = url.pathname.slice(prefix.length);
      if ((action === 'register' && req.method === 'POST') || (action === 'authorize' && req.method === 'GET')) {
        const limit = limits[action];
        if (Date.now() >= limit.reset) {
          limit.reset = Date.now() + 60000;
          limit.count = 0;
        }
        if (++limit.count > limit.max) {
          res.setHeader('Retry-After', Math.max(1, Math.ceil((limit.reset - Date.now()) / 1000)));
          throw new OAuthError('temporarily_unavailable', 429);
        }
      }
      if (url.pathname === '/.well-known/oauth-authorization-server' && req.method === 'GET') {
        json(res, 200, metadata);
      } else if (action === 'register' && req.method === 'POST') {
        const input = JSON.parse(await readBody(req, 'application/json'));
        if (!Array.isArray(input.redirect_uris) || !input.redirect_uris.length || input.redirect_uris.length > 8 ||
            !input.redirect_uris.every((uri: unknown) => allowedRedirect(uri, configuredRedirects))) {
          throw new OAuthError('invalid_redirect_uri');
        }
        if (input.token_endpoint_auth_method && input.token_endpoint_auth_method !== 'none') throw new OAuthError('invalid_client_metadata');
        await records().deleteMany({ where: { expiresAt: { lt: new Date() } } });
        if (await records().count({ where: { kind: 'registration' } }) >= 1000) throw new OAuthError('temporarily_unavailable', 503);
        const clientId = await save('registration', { redirects: input.redirect_uris }, ttl.registration);
        json(res, 201, { client_id: clientId, redirect_uris: input.redirect_uris, token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
      } else if (action === 'authorize' && req.method === 'GET') {
        const params = url.searchParams;
        requireResource(params, publicUrl!.href);
        const clientId = params.get('client_id') || '';
        const registration = await lookup<Registration>('registration', clientId);
        const redirect = params.get('redirect_uri') || '';
        const state = params.get('state') || '';
        const challenge = params.get('code_challenge') || '';
        if (!registration?.redirects.includes(redirect) || !state || state.length > 512 ||
            !handleFormat.test(challenge) || params.get('code_challenge_method') !== 'S256' || params.get('response_type') !== 'code') {
          throw new OAuthError('invalid_request');
        }
        const scope = parseScopes(params.get('scope'));
        const cookie = random();
        const verifier = random();
        const upstreamState = await save('state', { client: clientId, redirect, state, challenge, verifier, cookie: digest(cookie), scope }, ttl.state);
        res.setHeader('Set-Cookie', cookieHeader(upstreamState, cookie, ttl.state, publicUrl!.protocol === 'https:', 'callback'));
        const upstream = new URL(issuer + '/protocol/openid-connect/auth');
        upstream.search = new URLSearchParams({ client_id: client, redirect_uri: callback, scope: 'openid mcp-access',
          response_type: 'code', state: upstreamState, code_challenge_method: 'S256', code_challenge: digest(verifier) }).toString();
        redirectTo(res, upstream);
      } else if (action === 'callback' && req.method === 'GET') {
        const state = url.searchParams.get('state') || '';
        const flow = await lookup<Flow>('state', state);
        const cookie = readCookie(req, state);
        const code = url.searchParams.get('code');
        const tokenIssuer = url.searchParams.get('iss');
        if (!flow || !cookie || digest(cookie) !== flow.cookie || (tokenIssuer && tokenIssuer !== issuer)) throw new OAuthError('invalid_request');
        await consume('state', state);
        const secure = publicUrl!.protocol === 'https:';
        res.setHeader('Set-Cookie', cookieHeader(state, '', 0, secure, 'callback'));
        const next = new URL(flow.redirect);
        next.searchParams.set('state', flow.state);
        if (!code) {
          next.searchParams.set('error', 'access_denied');
          redirectTo(res, next);
          return true;
        }
        const tokens = await keycloak({ grant_type: 'authorization_code', code, redirect_uri: callback, code_verifier: flow.verifier });
        const approvalCookie = random();
        const handle = await save('approval', {
          client: flow.client, redirect: flow.redirect, state: flow.state, challenge: flow.challenge, scope: flow.scope,
          sealed: seal(JSON.stringify(tokens)), cookie: digest(approvalCookie),
        }, ttl.code);
        res.setHeader('Set-Cookie', [cookieHeader(state, '', 0, secure, 'callback'), cookieHeader(handle, approvalCookie, ttl.code, secure, 'approve')]);
        consent(res, handle, flow.scope);
      } else if (action === 'approve' && req.method === 'POST') {
        if (req.headers.origin !== origin) throw new OAuthError('invalid_request', 403);
        const params = new URLSearchParams(await readBody(req, 'application/x-www-form-urlencoded'));
        const handle = params.get('handle') || '';
        const decision = params.get('decision');
        const approval = await lookup<Approval>('approval', handle);
        const cookie = readCookie(req, handle);
        if (!approval || !cookie || digest(cookie) !== approval.cookie || !['yes', 'no'].includes(decision || '')) throw new OAuthError('invalid_request');
        await consume('approval', handle);
        res.setHeader('Set-Cookie', cookieHeader(handle, '', 0, publicUrl!.protocol === 'https:', 'approve'));
        const next = new URL(approval.redirect);
        next.searchParams.set('state', approval.state);
        if (decision === 'yes') {
          next.searchParams.set('code', await save('code', {
            client: approval.client, redirect: approval.redirect, challenge: approval.challenge,
            scope: approval.scope, sealed: approval.sealed,
          }, ttl.code));
        } else {
          next.searchParams.set('error', 'access_denied');
        }
        returnToAgent(res, next);
      } else if (action === 'token' && req.method === 'POST') {
        const params = new URLSearchParams(await readBody(req, 'application/x-www-form-urlencoded'));
        requireResource(params, publicUrl!.href);
        const clientId = params.get('client_id') || '';
        if (!await lookup<Registration>('registration', clientId)) throw new OAuthError('invalid_client', 401);
        if (params.get('grant_type') === 'authorization_code') {
          const handle = params.get('code') || '';
          const code = await lookup<Code>('code', handle);
          const verifier = params.get('code_verifier') || '';
          if (!code || code.client !== clientId || params.get('redirect_uri') !== code.redirect ||
              !verifierFormat.test(verifier) || digest(verifier) !== code.challenge) throw new OAuthError('invalid_grant');
          await consume('code', handle);
          await issue(res, clientId, JSON.parse(open(code.sealed)), code.scope);
        } else if (params.get('grant_type') === 'refresh_token') {
          const handle = params.get('refresh_token') || '';
          const grant = await lookup<Grant>('refresh', handle);
          if (!grant || grant.client !== clientId) throw new OAuthError('invalid_grant');
          const requested = parseScopes(params.get('scope'));
          if (requested && grant.scope && requested.some(scope => !grant.scope!.includes(scope))) throw new OAuthError('invalid_scope');
          await consume('refresh', handle);
          const refreshed = await keycloak({ grant_type: 'refresh_token', refresh_token: open(grant.sealed) });
          if (grant.accessId) await records().deleteMany({ where: { id: grant.accessId, kind: 'access' } });
          await issue(res, clientId, refreshed, requested ?? grant.scope);
        } else {
          throw new OAuthError('unsupported_grant_type');
        }
      } else {
        json(res, 404, { error: 'not_found' });
      }
    } catch (error) {
      const safe = error instanceof OAuthError ? error
        : error instanceof SyntaxError ? new OAuthError('invalid_request') : new OAuthError('temporarily_unavailable', 503);
      json(res, safe.status, { error: safe.code });
    }
    return true;
  };
}

function parseScopes(value: string | null) {
  if (!value) return undefined;
  const scope = [...new Set(value.split(' ').filter(Boolean))];
  if (!scope.length || scope.some(item => !supportedScopes.includes(item))) throw new OAuthError('invalid_scope');
  return scope;
}
function requireResource(params: URLSearchParams, resource: string) {
  if (params.getAll('resource').some(value => value !== resource)) throw new OAuthError('invalid_target');
}
function allowedRedirect(uri: unknown, configured: string[]) {
  if (typeof uri !== 'string' || uri.length > 1024) return false;
  try {
    const value = new URL(uri);
    if (value.hash || value.username || value.password || value.searchParams.has('code') || value.searchParams.has('state')) return false;
    return value.protocol === 'https:' ? configured.includes(uri)
      : value.protocol === 'http:' && !!value.port && ['127.0.0.1', '[::1]', 'localhost'].includes(value.hostname);
  } catch { return false; }
}
function cookieName(state: string) { return 'mcp_oauth_' + state.slice(0, 16); }
function readCookie(req: IncomingMessage, handle: string) {
  return req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith(cookieName(handle) + '='))?.split('=')[1];
}
function cookieHeader(state: string, value: string, seconds: number, secure: boolean, endpoint: 'callback' | 'approve') {
  return cookieName(state) + '=' + value + '; Path=' + prefix + endpoint + '; HttpOnly; SameSite=Lax; Max-Age=' + seconds + (secure ? '; Secure' : '');
}
async function readBody(req: IncomingMessage, contentType: string) {
  if (!req.headers['content-type']?.startsWith(contentType)) throw new OAuthError('invalid_request');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of req) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    size += bytes.length;
    if (size > 16384) throw new OAuthError('invalid_request', 413);
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}
function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  res.end(JSON.stringify(value));
}
function redirectTo(res: ServerResponse, url: URL) {
  res.writeHead(302, { Location: url.href, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  res.end();
}
function returnToAgent(res: ServerResponse, url: URL) {
  // A cross-origin 3xx after the consent form POST is blocked by Chrome's form-action policy.
  const href = url.href.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'" });
  res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=' +
    href + '"><title>返回工具</title><main><a rel="noreferrer" href="' + href + '">返回工具</a></main></html>');
}
function consent(res: ServerResponse, handle: string, scopes?: string[]) {
  const description = scopes ? '申请范围：' + scopes.join('、') : '允许工具使用你在靶场角色范围内的功能。';
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" });
  res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>授权访问靶场</title><main><h1>授权工具访问靶场</h1><p>' + description +
    '</p><form method="post" action="/mcp/oauth/approve"><input type="hidden" name="handle" value="' + handle +
    '"><button name="decision" value="yes">授权</button> <button name="decision" value="no">拒绝</button></form></main></html>');
}
