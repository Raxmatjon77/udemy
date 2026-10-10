import { Injectable } from '@nestjs/common';
import { type JwksResponse, JwksResponseSchema } from '@udemy/contracts';
import { KeyStore } from './ports/key-store';

/** `GetJwks` (design §5): the public half of every key in JWT_KEYS_DIR. */
@Injectable()
export class GetJwksQuery {
  private cached: JwksResponse | undefined;

  constructor(private readonly keys: KeyStore) {}

  /** Keys are loaded once at boot, so the document is built (and validated) once. */
  execute(): JwksResponse {
    this.cached ??= JwksResponseSchema.parse({ keys: this.keys.publicJwks() });
    return this.cached;
  }
}
