import { describe, expect, it } from 'vitest';

import { ADMIN_SCOPES, END_USER_SCOPES, scopesForRole } from '../src/auth';

describe('MCP auth scopes', () => {
  it('keeps end-user scopes as an explicit subset of admin scopes', () => {
    expect(END_USER_SCOPES.length).toBeGreaterThan(0);
    expect(new Set(ADMIN_SCOPES)).toEqual(new Set([...END_USER_SCOPES, ...ADMIN_SCOPES]));

    for (const scope of END_USER_SCOPES) {
      expect(ADMIN_SCOPES).toContain(scope);
    }

    expect(END_USER_SCOPES).not.toContain('billing:read');
    expect(END_USER_SCOPES).not.toContain('billing:sync');
    expect(ADMIN_SCOPES).toEqual(expect.arrayContaining(['billing:read', 'billing:sync']));
  });
});

describe('explicit OAuth business scope intersection', () => {
  it('retains the existing identity-only client contract', () => {
    expect(scopesForRole('admin', ['openid', 'profile'])).toEqual(ADMIN_SCOPES);
  });
  it('honors read-only scope and never elevates an ordinary user', () => {
    expect(scopesForRole('admin', ['images:read'])).toEqual(['images:read']);
    expect(scopesForRole('user', ['settings:write'])).toEqual([]);
  });
});
