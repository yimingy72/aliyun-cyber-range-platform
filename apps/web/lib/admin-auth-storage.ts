export const ADMIN_TOKEN_STORAGE_KEY = 'aliyun-cyber-range-admin-token';
const ADMIN_TOKEN_STORAGE_EVENT = 'aliyun-cyber-range-admin-token-change';

function normalizeAdminToken(token: string | null | undefined) {
  if (typeof token !== 'string') {
    return null;
  }

  const normalizedToken = token.trim();

  return normalizedToken ? normalizedToken : null;
}

function emitAdminTokenChanged() {
  if (typeof window === 'undefined') {
    return;
  }

  window.dispatchEvent(new Event(ADMIN_TOKEN_STORAGE_EVENT));
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

export function subscribeAdminToken(onChange: () => void) {
  if (typeof window === 'undefined') {
    return () => undefined;
  }

  const handleTokenChange = () => {
    onChange();
  };
  const handleStorageChange = (event: StorageEvent) => {
    if (event.key === null || event.key === ADMIN_TOKEN_STORAGE_KEY) {
      onChange();
    }
  };

  window.addEventListener(ADMIN_TOKEN_STORAGE_EVENT, handleTokenChange);
  window.addEventListener('storage', handleStorageChange);

  return () => {
    window.removeEventListener(ADMIN_TOKEN_STORAGE_EVENT, handleTokenChange);
    window.removeEventListener('storage', handleStorageChange);
  };
}

export function writeAdminToken(token: string) {
  const normalizedToken = normalizeAdminToken(token);

  if (!normalizedToken) {
    clearAdminToken();
    return null;
  }

  window.localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, normalizedToken);
  emitAdminTokenChanged();

  return normalizedToken;
}

export function clearAdminToken() {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
  emitAdminTokenChanged();
}
