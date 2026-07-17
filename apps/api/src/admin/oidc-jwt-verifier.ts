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
};

@Injectable()
export class OidcJwtVerifier {
  private readonly issuer = this.requireEnv('OIDC_ISSUER');
  private readonly jwksUrl = this.requireEnv('OIDC_JWKS_URL');
  private cachedKeys: OidcJwk[] | null = null;

  async verifyAccessToken(token: string): Promise<VerifiedOidcJwtClaims> {
    const [encodedHeader, encodedPayload, encodedSignature] = token.split('.');

    if (!encodedHeader || !encodedPayload || !encodedSignature) {
      throw new UnauthorizedException('OIDC token is malformed');
    }

    const header = this.decodeSegment<OidcJwtHeader>(encodedHeader);
    const payload = this.decodeSegment<OidcJwtPayload>(encodedPayload);

    if (header.alg !== 'RS256' || !header.kid) {
      throw new UnauthorizedException('OIDC token algorithm is invalid');
    }

    const audience = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];

    if (payload.iss !== this.issuer || !payload.sub) {
      throw new UnauthorizedException('OIDC token issuer or subject is invalid');
    }

    if (!audience.includes('platform-api')) {
      throw new UnauthorizedException('OIDC token audience is invalid');
    }

    const now = Math.floor(Date.now() / 1000);

    if (typeof payload.exp !== 'number' || payload.exp <= now) {
      throw new UnauthorizedException('OIDC token is expired');
    }

    if (typeof payload.nbf === 'number' && payload.nbf > now) {
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
      authorizedParty: typeof payload.azp === 'string' && payload.azp.trim() ? payload.azp : null,
    };
  }

  private async getSigningKey(kid: string) {
    const keys = await this.getJwks();
    const key = keys.find((item) => item.kid === kid);

    if (!key) {
      throw new UnauthorizedException('OIDC signing key was not found');
    }

    return key;
  }

  private async getJwks() {
    if (this.cachedKeys) {
      return this.cachedKeys;
    }

    const response = await fetch(this.jwksUrl);

    if (response.status !== 200) {
      throw new UnauthorizedException('OIDC JWKS fetch failed');
    }

    const payload = (await response.json()) as JwksResponse;

    if (!payload.keys?.length) {
      throw new UnauthorizedException('OIDC JWKS response is empty');
    }

    this.cachedKeys = payload.keys;
    return this.cachedKeys;
  }

  private decodeSegment<T>(segment: string) {
    try {
      return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as T;
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
