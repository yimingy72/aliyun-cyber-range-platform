import { describe, expect, it } from 'vitest';

import { ADMIN_SCOPES, END_USER_SCOPES } from '../src/auth';

describe('MCP auth scopes', () => {
  it('keeps end-user scopes as an explicit subset of admin scopes', () => {
    expect(END_USER_SCOPES.length).toBeGreaterThan(0);
    expect(new Set(ADMIN_SCOPES)).toEqual(new Set([...END_USER_SCOPES, ...ADMIN_SCOPES]));

    for (const scope of END_USER_SCOPES) {
      expect(ADMIN_SCOPES).toContain(scope);
    }
  });
});
