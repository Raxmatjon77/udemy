import { createHmac, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../../../shared/config';
import {
  type GeneratedRefreshToken,
  RefreshTokenCodec,
} from '../../application/ports/refresh-token.codec';

const TOKEN_BYTES = 32;

/**
 * Design D3: 32 random bytes, base64url; the DB stores HMAC-SHA256(REFRESH_TOKEN_PEPPER, token)
 * (a DB dump alone cannot be used to look tokens up). Rotating the pepper logs everyone out.
 */
@Injectable()
export class HmacRefreshTokenCodec extends RefreshTokenCodec {
  private readonly pepper: string;

  constructor(config: AppConfigService) {
    super();
    this.pepper = config.get('REFRESH_TOKEN_PEPPER');
  }

  generate(): GeneratedRefreshToken {
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    return { token, hash: this.hash(token) };
  }

  hash(token: string): Buffer {
    return createHmac('sha256', this.pepper).update(token, 'utf8').digest();
  }
}
