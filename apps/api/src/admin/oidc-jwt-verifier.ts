import { createPublicKey, type JsonWebKey as NodeJsonWebKey, webcrypto } from 'node:crypto';

import { Injectable, UnauthorizedException } from '@nestjs/common';

type OidcJwtHeader = {
  alg?: string;
  kid?: string;
  typ?: string;
};

type OidcJwtPayload = {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
  iat?: number;
  nbf?: number;
  azp?: string;
  scope?: string;
  typ?: string;
};

type OidcJwk = NodeJsonWebKey & {
  kid?: string;
  use?: string;
  alg?: string;
};

type JwksResponse = {
  keys?: OidcJwk[];
};

export type VerifiedOidcJwtClaims = {
  issuer: string;
  subject: string;
  audience: string[];
  authorizedParty: string | null;
  scopes?: string[];
};

@Injectable()
export class OidcJwtVerifier {
  private readonly issuer = this.requireEnv('OIDC_ISSUER');
  private readonly jwksUrl = this.requireEnv('OIDC_JWKS_URL');
  private readonly expectedAudience = process.env.PLATFORM_API_AUDIENCE?.trim() || 'platform-api';
  private cachedKeys: OidcJwk[] | null = null;
  private jwksRequest: Promise<OidcJwk[]> | null = null;
  private refreshAfter = 0;
  private cacheExpiresAt = 0;

  async verifyAccessToken(token: string): Promise<VerifiedOidcJwtClaims> {
    const parts = token.split('.');
    const [encodedHeader, encodedPayload, encodedSignature] = parts;

    if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) {
      throw new UnauthorizedException('OIDC token is malformed');
    }

    const header = this.decodeSegment<OidcJwtHeader>(encodedHeader);
    const payload = this.decodeSegment<OidcJwtPayload>(encodedPayload);

    if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid || header.kid.length > 256) {
      throw new UnauthorizedException('OIDC token algorithm is invalid');
    }

    const audience = Array.isArray(payload.aud) && payload.aud.every(value => typeof value === 'string')
      ? payload.aud : typeof payload.aud === 'string' ? [payload.aud] : [];

    if (payload.iss !== this.issuer || typeof payload.sub !== 'string' || !payload.sub.trim()) {
      throw new UnauthorizedException('OIDC token issuer or subject is invalid');
    }

    if (!audience.includes(this.expectedAudience)) {
      throw new UnauthorizedException('OIDC token audience is invalid');
    }

    if (payload.typ !== undefined && payload.typ !== 'Bearer'
      || payload.azp !== undefined && (typeof payload.azp !== 'string' || !payload.azp.trim())
      || payload.scope !== undefined && typeof payload.scope !== 'string') {
      throw new UnauthorizedException('OIDC access token claims are invalid');
    }

    const now = Math.floor(Date.now() / 1000);

    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || payload.exp <= now) {
      throw new UnauthorizedException('OIDC token is expired');
    }

    if (payload.nbf !== undefined && (typeof payload.nbf !== 'number' || !Number.isFinite(payload.nbf) || payload.nbf > now)
      || payload.iat !== undefined && (typeof payload.iat !== 'number' || !Number.isFinite(payload.iat) || payload.iat > now + 60)) {
      throw new UnauthorizedException('OIDC token is not active yet');
    }

    const key = await this.getSigningKey(header.kid);
    const publicKey = createPublicKey({ key, format: 'jwk' });
    const cryptoKey = await webcrypto.subtle.importKey(
      'spki',
      publicKey.export({ format: 'der', type: 'spki' }),
      {
        name: 'RSASSA-PKCS1-v1_5',
        hash: 'SHA-256',
      },
      false,
      ['verify'],
    );
    const signature = Buffer.from(encodedSignature, 'base64url');
    const isValid = await webcrypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      cryptoKey,
      signature,
      Buffer.from(`${encodedHeader}.${encodedPayload}`, 'utf8'),
    );

    if (!isValid) {
      throw new UnauthorizedException('OIDC token signature is invalid');
    }

    return {
      issuer: payload.iss,
      subject: payload.sub,
      audience,
      ...(payload.scope === undefined ? {} : { scopes: payload.scope.split(/\s+/).filter(Boolean) }),
      authorizedParty: typeof payload.azp === 'string' && payload.azp.trim() ? payload.azp : null,
    };
  }

  private async getSigningKey(kid: string) {
    const keys = await this.getJwks();
    let key = keys.find((item) => item.kid === kid);
    if (!key) {
      key = (await this.getJwks(true)).find((item) => item.kid === kid);
    }

    if (!key || key.kty !== 'RSA' || key.use !== undefined && key.use !== 'sig' || key.alg !== undefined && key.alg !== 'RS256') {
      throw new UnauthorizedException('OIDC signing key was not found');
    }

    return key;
  }

  private async getJwks(refresh = false): Promise<OidcJwk[]> {
    if (this.cachedKeys && !refresh && Date.now() < this.cacheExpiresAt) {
      return this.cachedKeys;
    }
    if (this.jwksRequest) {
      return this.jwksRequest;
    }
    if (this.cachedKeys && Date.now() < this.refreshAfter) {
      return this.cachedKeys;
    }

    // Coalesce rotation checks and bound unknown-kid requests from unverified tokens.
    if (refresh) {
      this.refreshAfter = Date.now() + 1_000;
    }
    this.jwksRequest = this.fetchJwks();
    try {
      return await this.jwksRequest;
    } finally {
      this.jwksRequest = null;
    }
  }

  private async fetchJwks(): Promise<OidcJwk[]> {
    const response = await fetch(this.jwksUrl, { signal: AbortSignal.timeout(5_000), redirect: 'error' });

    if (response.status !== 200) {
      throw new UnauthorizedException('OIDC JWKS fetch failed');
    }

    const payload = (await response.json()) as JwksResponse;

    if (!Array.isArray(payload.keys) || !payload.keys.length || payload.keys.some(key => !key || typeof key !== 'object')) {
      throw new UnauthorizedException('OIDC JWKS response is empty');
    }

    this.cachedKeys = payload.keys;
    this.cacheExpiresAt = Date.now() + 5 * 60_000;
    return this.cachedKeys;
  }

  private decodeSegment<T>(segment: string) {
    try {
      const value: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      return value as T;
    } catch {
      throw new UnauthorizedException('OIDC token is malformed');
    }
  }

  private requireEnv(name: string) {
    const value = process.env[name]?.trim();

    if (!value) {
      throw new Error(`${name} is required`);
    }

    return value;
  }
}
