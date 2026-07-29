import type { AdminProfile, AdminSessionPayload } from './admin-types';

export const ADMIN_SESSION_STORAGE_KEY = 'aliyun-cyber-range-admin-session';
export const ADMIN_SESSION_GENERATION_STORAGE_KEY = 'aliyun-cyber-range-admin-session-generation';
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

function normalizeAdminSessionGeneration(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function readAdminSessionGeneration() {
  if (typeof window === 'undefined') {
    return 0;
  }

  const storedGeneration = window.localStorage.getItem(ADMIN_SESSION_GENERATION_STORAGE_KEY);
  if (!storedGeneration || !storedGeneration.trim()) {
    return 0;
  }

  const generation = Number(storedGeneration);

  return Number.isSafeInteger(generation) && generation >= 0 ? generation : 0;
}

export function parseAdminSessionPayload(session: unknown): AdminSessionPayload | null {
  if (!session || typeof session !== 'object') {
    return null;
  }

  const nextSession = session as Record<string, unknown>;
  const token = normalizeAdminText(nextSession.token);
  const idToken = nextSession.idToken === undefined ? undefined : normalizeAdminText(nextSession.idToken);
  const refreshToken = nextSession.refreshToken === undefined ? undefined : normalizeAdminText(nextSession.refreshToken);
  const sessionGeneration =
    nextSession.sessionGeneration === undefined
      ? undefined
      : normalizeAdminSessionGeneration(nextSession.sessionGeneration);
  const profile = normalizeAdminProfile(nextSession.profile);

  if (!token || !profile || sessionGeneration === null) {
    return null;
  }

  return {
    token,
    idToken,
    refreshToken,
    ...(sessionGeneration === undefined ? {} : { sessionGeneration }),
    profile,
  };
}

function clearAdminSessionRecord() {
  window.localStorage.removeItem(ADMIN_SESSION_STORAGE_KEY);
}

function clearLegacyAdminTokenRecord() {
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
  const currentGeneration = readAdminSessionGeneration();

  if (!storedSession) {
    if (window.localStorage.getItem(LEGACY_ADMIN_TOKEN_STORAGE_KEY) !== null) {
      clearLegacyAdminTokenRecord();
    }
    updateCachedSession(null, null);
    return null;
  }

  if (storedSession === cachedSerializedSession) {
    if (cachedSession?.sessionGeneration === currentGeneration) {
      return cachedSession;
    }

    clearAdminSessionRecord();
    updateCachedSession(null, null);
    return null;
  }

  try {
    const normalizedSession = parseAdminSessionPayload(JSON.parse(storedSession));

    if (!normalizedSession) {
      clearAdminSessionRecord();
      clearLegacyAdminTokenRecord();
      updateCachedSession(null, null);
      return null;
    }

    if (normalizedSession.sessionGeneration === undefined && currentGeneration !== 0) {
      clearAdminSessionRecord();
      updateCachedSession(null, null);
      return null;
    }

    if (
      normalizedSession.sessionGeneration !== undefined &&
      normalizedSession.sessionGeneration !== currentGeneration
    ) {
      clearAdminSessionRecord();
      updateCachedSession(null, null);
      return null;
    }

    const sessionWithGeneration = {
      ...normalizedSession,
      sessionGeneration: currentGeneration,
    };
    const serializedSession = JSON.stringify(sessionWithGeneration);

    if (serializedSession !== storedSession) {
      window.localStorage.setItem(ADMIN_SESSION_STORAGE_KEY, serializedSession);
    }

    if (window.localStorage.getItem(LEGACY_ADMIN_TOKEN_STORAGE_KEY) !== null) {
      clearLegacyAdminTokenRecord();
    }

    updateCachedSession(serializedSession, sessionWithGeneration);

    return sessionWithGeneration;
  } catch {
    clearAdminSessionRecord();
    clearLegacyAdminTokenRecord();
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
      event.key === ADMIN_SESSION_GENERATION_STORAGE_KEY ||
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

  const normalizedSession = parseAdminSessionPayload(session);

  if (!normalizedSession) {
    clearAdminSession();
    return null;
  }

  const currentGeneration = readAdminSessionGeneration();
  if (
    normalizedSession.sessionGeneration !== undefined &&
    normalizedSession.sessionGeneration !== currentGeneration
  ) {
    return null;
  }

  const sessionWithGeneration = {
    ...normalizedSession,
    sessionGeneration: currentGeneration,
  };
  const serializedSession = JSON.stringify(sessionWithGeneration);

  if (window.localStorage.getItem(ADMIN_SESSION_GENERATION_STORAGE_KEY) !== String(currentGeneration)) {
    window.localStorage.setItem(ADMIN_SESSION_GENERATION_STORAGE_KEY, String(currentGeneration));
  }
  window.localStorage.setItem(ADMIN_SESSION_STORAGE_KEY, serializedSession);
  updateCachedSession(serializedSession, sessionWithGeneration);

  if (window.localStorage.getItem(LEGACY_ADMIN_TOKEN_STORAGE_KEY) !== null) {
    clearLegacyAdminTokenRecord();
  }

  emitAdminSessionChanged();

  return sessionWithGeneration;
}

export function clearAdminSession() {
  if (typeof window === 'undefined') {
    return;
  }

  clearAdminSessionRecord();
  clearLegacyAdminTokenRecord();
  updateCachedSession(null, null);
  emitAdminSessionChanged();
}

export function invalidateAdminSessionForLogout() {
  if (typeof window === 'undefined') {
    return;
  }

  const nextGeneration = readAdminSessionGeneration() + 1;

  window.localStorage.setItem(ADMIN_SESSION_GENERATION_STORAGE_KEY, String(nextGeneration));
  clearAdminSession();
}
