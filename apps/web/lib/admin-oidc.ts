import type { AdminSessionPayload } from './admin-types';

export const ADMIN_OIDC_STATE_STORAGE_KEY = 'aliyun-cyber-range-admin-oidc-state';
export const ADMIN_OIDC_CODE_VERIFIER_STORAGE_KEY = 'aliyun-cyber-range-admin-oidc-code-verifier';

export type AdminOidcAuthorizeInput = {
  issuer: string;
  clientId: string;
  redirectUri: string;
};

export type AdminOidcPendingLogin = {
  state: string;
  codeVerifier: string;
};

export type AdminOidcTokenResponse = {
  access_token?: string;
  refresh_token?: string;
};

export async function buildAdminOidcAuthorizeUrl(input: AdminOidcAuthorizeInput) {
  const state = createRandomString();
  const codeVerifier = createRandomString();
  const codeChallenge = await createCodeChallenge(codeVerifier);
  const url = new URL(`${trimTrailingSlash(input.issuer)}/protocol/openid-connect/auth`);

  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid profile email');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');

  return {
    url: url.toString(),
    state,
    codeVerifier,
  };
}

export function writePendingAdminOidcLogin(pendingLogin: AdminOidcPendingLogin) {
  if (typeof window === 'undefined') {
    return;
  }

  window.sessionStorage.setItem(ADMIN_OIDC_STATE_STORAGE_KEY, pendingLogin.state);
  window.sessionStorage.setItem(ADMIN_OIDC_CODE_VERIFIER_STORAGE_KEY, pendingLogin.codeVerifier);
}

export function consumePendingAdminOidcLogin(expectedState: string) {
  if (typeof window === 'undefined') {
    return null;
  }

  const storedState = window.sessionStorage.getItem(ADMIN_OIDC_STATE_STORAGE_KEY);
  const storedCodeVerifier = window.sessionStorage.getItem(ADMIN_OIDC_CODE_VERIFIER_STORAGE_KEY);

  window.sessionStorage.removeItem(ADMIN_OIDC_STATE_STORAGE_KEY);
  window.sessionStorage.removeItem(ADMIN_OIDC_CODE_VERIFIER_STORAGE_KEY);

  if (!storedState || !storedCodeVerifier || storedState !== expectedState) {
    return null;
  }

  return {
    state: storedState,
    codeVerifier: storedCodeVerifier,
  };
}

export async function exchangeAdminOidcCode(input: {
  issuer: string;
  clientId: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
}) {
  const response = await fetch(`${trimTrailingSlash(input.issuer)}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: input.clientId,
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
    }),
  });

  if (!response.ok) {
    return null;
  }

  return (await response.json()) as AdminOidcTokenResponse;
}

export async function refreshAdminOidcToken(input: {
  issuer: string;
  clientId: string;
  refreshToken: string;
}) {
  const response = await fetch(`${trimTrailingSlash(input.issuer)}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: input.clientId,
      refresh_token: input.refreshToken,
    }),
  });

  if (!response.ok) {
    return null;
  }

  return (await response.json()) as AdminOidcTokenResponse;
}

export function parseAdminOidcSessionPayload(tokenResponse: AdminOidcTokenResponse): AdminSessionPayload | null {
  const accessToken = normalizeText(tokenResponse.access_token);
  const refreshToken = normalizeText(tokenResponse.refresh_token);

  if (!accessToken) {
    return null;
  }

  const payload = decodeJwtPayload(accessToken);
  const subject = normalizeText(payload?.sub);
  const username = normalizeText(payload?.preferred_username) ?? normalizeText(payload?.email) ?? subject;
  const roles = Array.isArray(payload?.realm_access?.roles) ? payload.realm_access.roles : [];
  const role = roles.includes('admin') ? 'admin' : roles.includes('user') ? 'user' : null;

  if (!subject || !username || !role) {
    return null;
  }

  return {
    token: accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    profile: {
      id: subject,
      username,
      role,
    },
  };
}

export function readAdminOidcTokenExpiresAt(token: string) {
  const payload = decodeJwtPayload(token) as { exp?: number } | null;
  return typeof payload?.exp === 'number' ? payload.exp * 1000 : null;
}

function decodeJwtPayload(token: string) {
  const [, encodedPayload] = token.split('.');

  if (!encodedPayload) {
    return null;
  }

  try {
    return JSON.parse(decodeBase64UrlToUtf8(encodedPayload)) as {
      sub?: string;
      preferred_username?: string;
      email?: string;
      realm_access?: { roles?: string[] };
    };
  } catch {
    return null;
  }
}

function normalizeText(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

async function createCodeChallenge(codeVerifier: string) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
  return encodeBase64Url(new Uint8Array(digest));
}

function createRandomString() {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

function trimTrailingSlash(value: string) {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function encodeBase64Url(bytes: Uint8Array) {
  let value = '';

  for (const byte of bytes) {
    value += String.fromCharCode(byte);
  }

  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeBase64UrlToUtf8(value: string) {
  const normalizedValue = value.replace(/-/g, '+').replace(/_/g, '/');
  const paddingLength = (4 - (normalizedValue.length % 4)) % 4;
  const paddedValue = normalizedValue + '='.repeat(paddingLength);
  const binary = atob(paddedValue);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));

  return new TextDecoder().decode(bytes);
}
