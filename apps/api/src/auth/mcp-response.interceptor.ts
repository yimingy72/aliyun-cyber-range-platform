import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { map } from 'rxjs/operators';
import type { RequestAuthContext } from './request-auth-context';

const secretKeys = new Set(['password', 'custompassword', 'defaultpassword', 'runtimecredentials', 'credentials',
  'ssh', 'vnc', 'vncurl', 'vncpassword', 'accesstoken', 'refreshtoken', 'accesskeyid', 'accesskeysecret', 'secretkey']);

export function redactMcpMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactMcpMetadata);
  if (!value || typeof value !== 'object') return value;
  if (typeof (value as { toJSON?: unknown }).toJSON === 'function')
    return redactMcpMetadata((value as { toJSON(): unknown }).toJSON());
  return Object.fromEntries(Object.entries(value).filter(([key, child]) => !secretKeys.has(key.replace(/[_-]/g, '').toLowerCase())
      || typeof child === 'string' && /^\*+$/.test(child))
    .map(([key, child]) => [key, redactMcpMetadata(child)]));
}

@Injectable()
export class McpResponseInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const request = context.switchToHttp().getRequest<{ authContext?: RequestAuthContext; method?: string; originalUrl?: string; url?: string }>();
    const path = (request.originalUrl ?? request.url ?? '').split('?')[0];
    // Credential retrieval has its own scopes and owner checks. Ordinary metadata never carries guest secrets.
    const access = request.method === 'GET' && /^\/admin\/(?:instances|ranges)\/[^/]+\/access$/.test(path)
      || request.method === 'POST' && /^\/admin\/(?:instances\/[^/]+|ranges\/[^/]+\/nodes\/[^/]+)\/actions\/open-vnc$/.test(path);
    if (request.authContext?.source !== 'mcp' && request.authContext?.delegatedScopes === undefined || access) return next.handle();
    return next.handle().pipe(map(redactMcpMetadata));
  }
}
