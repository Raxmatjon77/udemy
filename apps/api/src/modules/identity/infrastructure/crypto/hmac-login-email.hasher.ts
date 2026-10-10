import { createHmac } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../../../shared/config';
import { LoginEmailHasher } from '../../application/ports/login-email.hasher';

/** HMAC-SHA256(LOGIN_EMAIL_HMAC_KEY, normalised email). */
@Injectable()
export class HmacLoginEmailHasher extends LoginEmailHasher {
  private readonly key: string;

  constructor(config: AppConfigService) {
    super();
    this.key = config.get('LOGIN_EMAIL_HMAC_KEY');
  }

  hash(normalizedEmail: string): Buffer {
    return createHmac('sha256', this.key).update(normalizedEmail, 'utf8').digest();
  }
}
