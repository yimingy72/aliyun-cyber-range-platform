export const ADMIN_TOKEN_STORAGE_KEY = 'aliyun-cyber-range-admin-token';

function normalizeAdminToken(token: string | null | undefined) {
  if (typeof token !== 'string') {
    return null;
  }

  const normalizedToken = token.trim();

  return normalizedToken ? normalizedToken : null;
}

export function readAdminToken() {
  if (typeof window === 'undefined') {
    return null;
  }

  const storedToken = window.localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY);
  const normalizedToken = normalizeAdminToken(storedToken);

  if (!normalizedToken) {
    window.localStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
    return null;
  }

  if (normalizedToken !== storedToken) {
    window.localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, normalizedToken);
  }

  return normalizedToken;
}

export function writeAdminToken(token: string) {
  const normalizedToken = normalizeAdminToken(token);

  if (!normalizedToken) {
    clearAdminToken();
    return null;
  }

  window.localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, normalizedToken);

  return normalizedToken;
}

export function clearAdminToken() {
  window.localStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
}
