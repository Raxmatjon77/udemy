import { Injectable } from '@nestjs/common';
import { CatalogClock } from '../application/ports/catalog-clock';

/** `Date.now()`. */
@Injectable()
export class SystemCatalogClock extends CatalogClock {
  nowMs(): number {
    return Date.now();
  }
}
