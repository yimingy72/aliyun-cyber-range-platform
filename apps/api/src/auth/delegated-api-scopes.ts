import { ForbiddenException } from '@nestjs/common';
import type { SessionUserProfile } from '../admin/admin-user-auth';

const userScopes = [
  'templates:read', 'templates:write', 'templates:publish', 'templates:delete',
  'images:read', 'images:write',
  'ranges:read', 'ranges:create', 'ranges:write', 'ranges:control', 'ranges:destroy',
  'instances:read', 'instances:create', 'instances:control', 'instances:destroy', 'instances:credentials:read',
  'jobs:read',
];
const adminScopes = [...userScopes, 'users:read', 'users:write', 'billing:read', 'billing:sync', 'settings:read', 'settings:write'];

const identityScopes = new Set(['openid', 'profile', 'email', 'address', 'phone', 'offline_access', 'roles', 'web-origins', 'acr', 'basic']);

export function hasDelegatedScopes(scopes?: readonly string[]) {
  return scopes?.some(scope => !identityScopes.has(scope)) === true;
}

export function resolveDelegatedScopes(role: SessionUserProfile['role'], tokenScopes?: readonly string[]) {
  const allowed = role === 'admin' ? adminScopes : userScopes;
  return new Set(hasDelegatedScopes(tokenScopes) ? tokenScopes!.filter(scope => allowed.includes(scope)) : allowed);
}

type ScopeRule = { method: string; path: RegExp; all?: string[]; any?: string[] };
const metadataScopes = (namespace: string) => [...userScopes, ...adminScopes].filter(scope => scope.startsWith(`${namespace}:`));
const rules: ScopeRule[] = [
  // Own session/workspace metadata is required to resolve the target before a composite tool operates.
  { method: 'GET', path: /^\/admin\/(?:session|cloud-workspaces\/current)$/ },
  { method: 'GET', path: /^\/admin\/cloud-workspaces$/, all: ['settings:read'] },
  { method: 'POST', path: /^\/admin\/cloud-workspaces\/[^/]+\/switch$/, all: ['settings:write'] },
  { method: 'DELETE', path: /^\/admin\/cloud-workspaces\/[^/]+$/, all: ['settings:write'] },
  { method: 'GET', path: /^\/admin\/cloud-contexts(?:\/[^/]+\/instance-type-availability)?$/, all: ['settings:read'] },
  { method: 'POST', path: /^\/admin\/cloud-contexts$/, all: ['settings:write'] },
  { method: 'GET', path: /^\/admin\/system-config$/, all: ['settings:read'] },
  { method: 'PATCH', path: /^\/admin\/system-config$/, all: ['settings:write'] },
  { method: 'GET', path: /^\/admin\/system-config\/instance-type-availability$/, any: ['settings:read', 'instances:read', 'instances:create', 'ranges:create', 'ranges:write'] },
  { method: 'POST', path: /^\/admin\/tencent-cloud\/regions\/query$/, all: ['settings:read'] },
  { method: 'GET', path: /^\/admin\/tencent-cloud\/contexts\/[^/]+\/images$/, all: ['settings:read', 'images:read'] },
  { method: 'GET', path: /^\/admin\/users$/, all: ['users:read'] },
  { method: 'POST', path: /^\/admin\/users(?:\/[^/]+\/reset-password)?$/, all: ['users:write'] },
  { method: 'PATCH', path: /^\/admin\/users\/[^/]+\/(?:role|status)$/, all: ['users:write'] },
  { method: 'GET', path: /^\/admin\/billing\/(?:summary|users|user-groups|users\/[^/]+(?:\/items)?|platform\/(?:items|groups)|anomalies|export\/(?:platform\.csv|users\.csv|users\/[^/]+\.csv))$/, all: ['billing:read'] },
  { method: 'POST', path: /^\/admin\/billing\/sync$/, all: ['billing:sync'] },
  { method: 'GET', path: /^\/admin\/platform-image-tags$/, any: metadataScopes('images') },
  { method: 'POST', path: /^\/admin\/platform-image-tags$/, all: ['images:write'] },
  { method: 'GET', path: /^\/admin\/platform-images(?:\/[^/]+)?$/, any: metadataScopes('images') },
  { method: 'POST', path: /^\/admin\/platform-images(?:\/[^/]+\/(?:enable|disable|publish|unpublish))?$/, all: ['images:write'] },
  { method: 'PATCH', path: /^\/admin\/platform-images\/[^/]+$/, all: ['images:write'] },
  { method: 'PUT', path: /^\/admin\/platform-images\/[^/]+\/tags$/, all: ['images:write'] },
  { method: 'DELETE', path: /^\/admin\/platform-images\/[^/]+$/, all: ['images:write'] },
  { method: 'GET', path: /^\/admin\/image-catalog\/(?:public|custom)$/, all: ['images:read'] },
  { method: 'POST', path: /^\/admin\/image-catalog\/(?:public|custom)\/sync$/, all: ['images:read'] },
  { method: 'DELETE', path: /^\/admin\/image-catalog\/custom\/[^/]+$/, all: ['images:write'] },
  { method: 'GET', path: /^\/admin\/image-imports(?:\/[^/]+)?$/, any: metadataScopes('images') },
  { method: 'POST', path: /^\/admin\/image-imports\/[^/]+\/retry$/, all: ['images:write'] },
  { method: 'GET', path: /^\/admin\/scenarios(?:\/[^/]+)?$/, any: metadataScopes('templates') },
  { method: 'POST', path: /^\/admin\/scenarios(?:\/[^/]+\/(?:clone|validate-and-save))?$/, all: ['templates:write'] },
  { method: 'PATCH', path: /^\/admin\/scenarios\/[^/]+$/, all: ['templates:write'] },
  { method: 'POST', path: /^\/admin\/scenarios\/[^/]+\/(?:share|unshare)$/, all: ['templates:publish'] },
  { method: 'DELETE', path: /^\/admin\/scenarios\/[^/]+$/, all: ['templates:delete'] },
  { method: 'GET', path: /^\/admin\/provision-jobs(?:\/[^/]+)?$/, all: ['jobs:read'] },
  { method: 'GET', path: /^\/admin\/ranges(?:\/[^/]+)?$/, any: metadataScopes('ranges') },
  { method: 'GET', path: /^\/admin\/ranges\/[^/]+\/access$/, all: ['ranges:read', 'instances:credentials:read'] },
  { method: 'POST', path: /^\/admin\/ranges\/launch$/, all: ['ranges:create'] },
  { method: 'PATCH', path: /^\/admin\/ranges\/[^/]+\/draft$/, all: ['ranges:write'] },
  { method: 'DELETE', path: /^\/admin\/ranges\/[^/]+\/draft$/, all: ['ranges:write'] },
  { method: 'POST', path: /^\/admin\/ranges\/[^/]+\/preview$/, all: ['ranges:read'] },
  { method: 'POST', path: /^\/admin\/ranges\/[^/]+\/apply$/, all: ['ranges:write', 'ranges:control'] },
  { method: 'POST', path: /^\/admin\/ranges\/[^/]+\/templates$/, all: ['ranges:read', 'templates:write'] },
  { method: 'POST', path: /^\/admin\/ranges\/[^/]+\/sync-template$/, all: ['ranges:write', 'templates:write'] },
  { method: 'POST', path: /^\/admin\/ranges\/[^/]+\/destroy$/, all: ['ranges:destroy'] },
  { method: 'POST', path: /^\/admin\/ranges\/[^/]+\/retry$/, all: ['ranges:control'] },
  { method: 'POST', path: /^\/admin\/ranges\/[^/]+\/nodes\/[^/]+\/actions\/open-vnc$/, all: ['ranges:read', 'instances:credentials:read'] },
  { method: 'POST', path: /^\/admin\/ranges\/[^/]+\/nodes\/[^/]+\/actions\/(?:start|stop|reboot|verify-dns|apply-dns)$/, all: ['ranges:control'] },
  { method: 'POST', path: /^\/admin\/ranges\/[^/]+\/nodes\/[^/]+\/actions\/pack-image$/, all: ['ranges:control', 'images:write'] },
  { method: 'POST', path: /^\/admin\/ranges\/[^/]+\/nodes\/[^/]+\/pack-image-validation$/, all: ['ranges:read', 'images:read'] },
  { method: 'GET', path: /^\/admin\/instances\/networks$/, all: ['settings:read'] },
  { method: 'GET', path: /^\/admin\/instances(?:\/[^/]+(?:\/cloud-resource-status)?)?$/, any: metadataScopes('instances') },
  { method: 'GET', path: /^\/admin\/instances\/[^/]+\/access$/, all: ['instances:read', 'instances:credentials:read'] },
  { method: 'POST', path: /^\/admin\/instances\/launch$/, all: ['instances:create'] },
  { method: 'POST', path: /^\/admin\/instances\/networks\/[^/]+\/register-cleanup$/, all: ['settings:write'] },
  { method: 'POST', path: /^\/admin\/instances\/networks\/[^/]+\/destroy$/, all: ['settings:write', 'instances:destroy'] },
  { method: 'POST', path: /^\/admin\/instances\/(?:[^/]+\/destroy|batches\/[^/]+\/destroy-all)$/, all: ['instances:destroy'] },
  { method: 'POST', path: /^\/admin\/instances\/[^/]+\/(?:retry|actions\/reboot)$/, all: ['instances:control'] },
  { method: 'POST', path: /^\/admin\/instances\/[^/]+\/actions\/open-vnc$/, all: ['instances:read', 'instances:credentials:read'] },
  { method: 'POST', path: /^\/admin\/instances\/[^/]+\/actions\/pack-image$/, all: ['instances:control', 'images:write'] },
];

export function assertDelegatedApiScopes(method: string, path: string, scopes: ReadonlySet<string>) {
  const rule = rules.find(candidate => candidate.method === method.toUpperCase() && candidate.path.test(path));
  if (!rule || rule.all?.some(scope => !scopes.has(scope)) || rule.any && !rule.any.some(scope => scopes.has(scope)))
    throw new ForbiddenException('Delegated token lacks permission for this API operation');
}
