const DEFAULT_OIDC_ISSUER = 'http://localhost:8080/realms/cyber-range';
const DEFAULT_OIDC_CLIENT_ID = 'platform-web';

export function resolveAdminOidcIssuer(value = process.env.NEXT_PUBLIC_OIDC_ISSUER) {
  const normalizedValue = value?.trim();
  return normalizedValue || DEFAULT_OIDC_ISSUER;
}

export function resolveAdminOidcClientId(value = process.env.NEXT_PUBLIC_OIDC_CLIENT_ID) {
  const normalizedValue = value?.trim();
  return normalizedValue || DEFAULT_OIDC_CLIENT_ID;
}
