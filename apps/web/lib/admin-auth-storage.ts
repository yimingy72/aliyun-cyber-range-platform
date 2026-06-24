export const ADMIN_TOKEN_STORAGE_KEY = 'aliyun-cyber-range-admin-token';

export function readAdminToken() {
  if (typeof window === 'undefined') {
    return null;
  }

  return window.localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY);
}

export function writeAdminToken(token: string) {
  window.localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, token);
}

export function clearAdminToken() {
  window.localStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
}
