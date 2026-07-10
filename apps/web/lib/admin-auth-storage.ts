import type { AdminProfile, AdminSessionPayload } from './admin-types';

export const ADMIN_SESSION_STORAGE_KEY = 'aliyun-cyber-range-admin-session';
const LEGACY_ADMIN_TOKEN_STORAGE_KEY = 'aliyun-cyber-range-admin-token';
const ADMIN_SESSION_STORAGE_EVENT = 'aliyun-cyber-range-admin-session-change';
let cachedSerializedSession: string | null = null;
let cachedSession: AdminSessionPayload | null = null;

function normalizeAdminText(value: unknown) {
  if (typeof value !== 'string') {
    return null;
  }

  const normalizedValue = value.trim();

  return normalizedValue ? normalizedValue : null;
}

function normalizeAdminProfile(profile: unknown): AdminProfile | null {
  if (!profile || typeof profile !== 'object') {
    return null;
  }

  const nextProfile = profile as Record<string, unknown>;
  const id = normalizeAdminText(nextProfile.id);
  const username = normalizeAdminText(nextProfile.username);
  const role = nextProfile.role;

  if (!id || !username || (role !== 'admin' && role !== 'user')) {
    return null;
  }

  return {
    id,
    username,
    role,
  };
}

function normalizeAdminSession(session: unknown): AdminSessionPayload | null {
  if (!session || typeof session !== 'object') {
    return null;
  }

  const nextSession = session as Record<string, unknown>;
  const token = normalizeAdminText(nextSession.token);
  const profile = normalizeAdminProfile(nextSession.profile);

  if (!token || !profile) {
    return null;
  }

  return {
    token,
    profile,
  };
}

function clearAdminStorageKeys() {
  window.localStorage.removeItem(ADMIN_SESSION_STORAGE_KEY);
  window.localStorage.removeItem(LEGACY_ADMIN_TOKEN_STORAGE_KEY);
}

function updateCachedSession(serializedSession: string | null, session: AdminSessionPayload | null) {
  cachedSerializedSession = serializedSession;
  cachedSession = session;
}

function emitAdminSessionChanged() {
  if (typeof window === 'undefined') {
    return;
  }

  window.dispatchEvent(new Event(ADMIN_SESSION_STORAGE_EVENT));
}

export function readAdminSession() {
  if (typeof window === 'undefined') {
    return null;
  }

  const storedSession = window.localStorage.getItem(ADMIN_SESSION_STORAGE_KEY);

  if (!storedSession) {
    updateCachedSession(null, null);
    return null;
  }

  if (storedSession === cachedSerializedSession) {
    return cachedSession;
  }

  try {
    const normalizedSession = normalizeAdminSession(JSON.parse(storedSession));

    if (!normalizedSession) {
      clearAdminStorageKeys();
      updateCachedSession(null, null);
      return null;
    }

    const serializedSession = JSON.stringify(normalizedSession);

    if (serializedSession !== storedSession) {
      window.localStorage.setItem(ADMIN_SESSION_STORAGE_KEY, serializedSession);
    }

    updateCachedSession(serializedSession, normalizedSession);

    return normalizedSession;
  } catch {
    clearAdminStorageKeys();
    updateCachedSession(null, null);
    return null;
  }
}

export function subscribeAdminSession(onChange: () => void) {
  if (typeof window === 'undefined') {
    return () => undefined;
  }

  const handleSessionChange = () => {
    onChange();
  };
  const handleStorageChange = (event: StorageEvent) => {
    if (
      event.key === null ||
      event.key === ADMIN_SESSION_STORAGE_KEY ||
      event.key === LEGACY_ADMIN_TOKEN_STORAGE_KEY
    ) {
      onChange();
    }
  };

  window.addEventListener(ADMIN_SESSION_STORAGE_EVENT, handleSessionChange);
  window.addEventListener('storage', handleStorageChange);

  return () => {
    window.removeEventListener(ADMIN_SESSION_STORAGE_EVENT, handleSessionChange);
    window.removeEventListener('storage', handleStorageChange);
  };
}

export function writeAdminSession(session: AdminSessionPayload) {
  if (typeof window === 'undefined') {
    return null;
  }

  const normalizedSession = normalizeAdminSession(session);

  if (!normalizedSession) {
    clearAdminSession();
    return null;
  }

  const serializedSession = JSON.stringify(normalizedSession);

  clearAdminStorageKeys();
  window.localStorage.setItem(ADMIN_SESSION_STORAGE_KEY, serializedSession);
  updateCachedSession(serializedSession, normalizedSession);
  emitAdminSessionChanged();

  return normalizedSession;
}

export function clearAdminSession() {
  if (typeof window === 'undefined') {
    return;
  }

  clearAdminStorageKeys();
  updateCachedSession(null, null);
  emitAdminSessionChanged();
}
