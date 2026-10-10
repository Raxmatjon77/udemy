import { Injectable } from '@nestjs/common';
import { SignJWT } from 'jose';
import { AppConfigService } from '../../../../shared/config';
import {
  AccessTokenIssuer,
  type AccessTokenSubject,
  type IssuedAccessToken,
} from '../../application/ports/access-token-issuer';
import { ACCESS_TOKEN_ALGORITHM, ACCESS_TOKEN_TTL_SECONDS } from '../../domain/access-token';
import { FileKeyStore } from '../keys/file-key.store';
import { uuidv7 } from './uuidv7';

/**
 * EdDSA (Ed25519) access tokens (design D1, §9). Header `{ alg: 'EdDSA', kid }`; claims
 * exactly `iss, aud, sub, sid, app, roles, iat, exp, jti`. No email, permissions or
 * verification state.
 */
@Injectable()
export class JoseAccessTokenIssuer extends AccessTokenIssuer {
  constructor(
    private readonly keys: FileKeyStore,
    private readonly config: AppConfigService,
  ) {
    super();
  }

  async issue(subject: AccessTokenSubject): Promise<IssuedAccessToken> {
    const { kid, key } = this.keys.signingKey();
    const nowMs = Date.now();
    const iat = Math.floor(nowMs / 1000);
    const exp = iat + ACCESS_TOKEN_TTL_SECONDS;
    const jti = uuidv7(nowMs);

    const token = await new SignJWT({
      sid: subject.sessionId,
      app: subject.app,
      roles: [...subject.roles],
    })
      .setProtectedHeader({ alg: ACCESS_TOKEN_ALGORITHM, kid })
      .setIssuer(this.config.get('API_PUBLIC_URL'))
      .setAudience(this.config.get('JWT_AUDIENCE'))
      .setSubject(subject.userId)
      .setIssuedAt(iat)
      .setExpirationTime(exp)
      .setJti(jti)
      .sign(key);

    return {
      token,
      tokenId: jti,
      issuedAt: new Date(iat * 1000),
      expiresAt: new Date(exp * 1000),
      kid,
    };
  }
}
