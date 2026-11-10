export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  if (process.env.NEXT_PUBLIC_PLATFORM_AUTH_MODE !== 'keycloak') return new Response(null, { status: 404 });
  const endpoint = process.env.OIDC_TOKEN_ENDPOINT;
  const secret = process.env.OIDC_UNIFIED_CLIENT_SECRET;
  const redirectUri = process.env.OIDC_UNIFIED_WEB_REDIRECT_URI;
  if (!endpoint || !secret || !redirectUri) return new Response(null, { status: 503 });
  if (request.headers.get('origin') !== new URL(redirectUri).origin ||
      !request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) {
    return new Response(null, { status: 403 });
  }
  const input = await request.text();
  if (input.length > 16384) return new Response(null, { status: 413 });
  const params = new URLSearchParams(input);
  const grant = params.get('grant_type');
  const body = new URLSearchParams({
    client_id: process.env.NEXT_PUBLIC_OIDC_CLIENT_ID || 'cyber-range',
    client_secret: secret,
  });
  if (grant === 'authorization_code') {
    const code = params.get('code');
    const verifier = params.get('code_verifier');
    if (!code || !verifier || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || params.get('redirect_uri') !== redirectUri) {
      return new Response(null, { status: 400 });
    }
    body.set('code', code);
    body.set('code_verifier', verifier);
    body.set('redirect_uri', redirectUri);
  } else if (grant === 'refresh_token') {
    const refreshToken = params.get('refresh_token');
    if (!refreshToken) return new Response(null, { status: 400 });
    body.set('refresh_token', refreshToken);
  } else {
    return new Response(null, { status: 400 });
  }
  body.set('grant_type', grant);
  try {
    const response = await fetch(endpoint, {
      method: 'POST', body, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return new Response(null, { status: response.status < 500 ? 401 : 503 });
    const token = await response.json();
    if (typeof token.access_token !== 'string') return new Response(null, { status: 503 });
    return Response.json({
      access_token: token.access_token, refresh_token: token.refresh_token,
      id_token: token.id_token, expires_in: token.expires_in, token_type: token.token_type,
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return new Response(null, { status: 503 });
  }
}
