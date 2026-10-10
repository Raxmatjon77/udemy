import { Injectable } from '@nestjs/common';
import { type Executor, findOrderOwner } from '@udemy/db';
import { type Database, InjectDatabase } from '@udemy/nest-common';
import { OrderOwnerReader } from '../application/ports/order-owner.reader';

@Injectable()
export class KyselyOrderOwnerReader extends OrderOwnerReader {
  constructor(@InjectDatabase() private readonly db: Database) {
    super();
  }

  ownerOf(orderId: string, ex: Executor = this.db): Promise<string | null> {
    return findOrderOwner(ex, orderId);
  }
}
