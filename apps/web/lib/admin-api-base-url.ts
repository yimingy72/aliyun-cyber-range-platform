const DEFAULT_ADMIN_API_BASE_URL = 'http://localhost:3001';

export function resolveAdminApiBaseUrl(value = process.env.NEXT_PUBLIC_API_BASE_URL) {
  const normalizedValue = value?.trim();

  return normalizedValue || DEFAULT_ADMIN_API_BASE_URL;
}
