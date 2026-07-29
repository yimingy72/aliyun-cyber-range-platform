import { beforeEach, describe, expect, it } from 'vitest';

import type { AdminSessionPayload } from './admin-types';
import {
  ADMIN_SESSION_GENERATION_STORAGE_KEY,
  ADMIN_SESSION_STORAGE_KEY,
  clearAdminSession,
  invalidateAdminSessionForLogout,
  readAdminSession,
  writeAdminSession,
} from './admin-auth-storage';

const storage = new Map<string, string>();

Object.defineProperty(window, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
  },
});

function createSession(overrides?: Partial<AdminSessionPayload>): AdminSessionPayload {
  return {
    token: overrides?.token ?? 'access-token',
    idToken: overrides?.idToken,
    refreshToken: overrides?.refreshToken ?? 'refresh-token',
    profile: {
      id: overrides?.profile?.id ?? 'admin-id',
      username: overrides?.profile?.username ?? 'admin',
      role: overrides?.profile?.role ?? 'admin',
    },
  };
}

describe('admin auth storage', () => {
  beforeEach(() => {
    storage.clear();
    clearAdminSession();
    storage.clear();
  });

  it('assigns the current generation to a normal session write', () => {
    const session = writeAdminSession(createSession());

    expect((session as { sessionGeneration?: number } | null)?.sessionGeneration).toBe(0);
    expect(readAdminSession()).toEqual(session);
    expect(JSON.parse(storage.get(ADMIN_SESSION_STORAGE_KEY) ?? '{}').sessionGeneration).toBe(0);
    expect(storage.get(ADMIN_SESSION_GENERATION_STORAGE_KEY)).toBe('0');
  });

  it('increments the generation and clears the session for explicit logout', () => {
    writeAdminSession(createSession());

    invalidateAdminSessionForLogout();

    expect(storage.get(ADMIN_SESSION_GENERATION_STORAGE_KEY)).toBe('1');
    expect(readAdminSession()).toBeNull();
  });

  it('rejects a stale session write after explicit logout', () => {
    const staleSession = writeAdminSession(createSession());

    invalidateAdminSessionForLogout();

    expect(writeAdminSession(staleSession as AdminSessionPayload)).toBeNull();
    expect(storage.get(ADMIN_SESSION_STORAGE_KEY)).toBeUndefined();
    expect(storage.get(ADMIN_SESSION_GENERATION_STORAGE_KEY)).toBe('1');
  });

  it('rejects a late stale record after the logout generation advances', () => {
    const staleSession = writeAdminSession(createSession());
    const staleRecord = storage.get(ADMIN_SESSION_STORAGE_KEY);

    expect((staleSession as { sessionGeneration?: number } | null)?.sessionGeneration).toBe(0);
    expect(staleRecord).toBeTruthy();

    invalidateAdminSessionForLogout();
    storage.set(ADMIN_SESSION_STORAGE_KEY, staleRecord as string);

    expect(readAdminSession()).toBeNull();
    expect(storage.get(ADMIN_SESSION_STORAGE_KEY)).toBeUndefined();
    expect(storage.get(ADMIN_SESSION_GENERATION_STORAGE_KEY)).toBe('1');
  });

  it('rejects an untagged legacy record after logout generation advances', () => {
    storage.set(ADMIN_SESSION_GENERATION_STORAGE_KEY, '1');
    storage.set(ADMIN_SESSION_STORAGE_KEY, JSON.stringify(createSession()));

    expect(readAdminSession()).toBeNull();
    expect(storage.get(ADMIN_SESSION_STORAGE_KEY)).toBeUndefined();
    expect(storage.get(ADMIN_SESSION_GENERATION_STORAGE_KEY)).toBe('1');
  });

  it('migrates an untagged legacy record only at generation zero', () => {
    storage.set(ADMIN_SESSION_STORAGE_KEY, JSON.stringify(createSession()));

    expect(readAdminSession()?.sessionGeneration).toBe(0);
    expect(JSON.parse(storage.get(ADMIN_SESSION_STORAGE_KEY) ?? '{}').sessionGeneration).toBe(0);
  });

  it('rejects a persisted session from an older generation without erasing the marker', () => {
    storage.set(ADMIN_SESSION_GENERATION_STORAGE_KEY, '3');
    storage.set(
      ADMIN_SESSION_STORAGE_KEY,
      JSON.stringify({
        ...createSession(),
        sessionGeneration: 2,
      }),
    );

    expect(readAdminSession()).toBeNull();
    expect(storage.get(ADMIN_SESSION_STORAGE_KEY)).toBeUndefined();
    expect(storage.get(ADMIN_SESSION_GENERATION_STORAGE_KEY)).toBe('3');
  });

  it('assigns the newer generation to a session written after explicit logout', () => {
    writeAdminSession(createSession());
    invalidateAdminSessionForLogout();

    const session = writeAdminSession(createSession({ token: 'next-access-token' }));

    expect((session as { sessionGeneration?: number } | null)?.sessionGeneration).toBe(1);
    expect(readAdminSession()).toEqual(session);
    expect(storage.get(ADMIN_SESSION_GENERATION_STORAGE_KEY)).toBe('1');
  });
});
