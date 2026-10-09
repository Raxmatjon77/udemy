import { Injectable } from '@nestjs/common';

/**
 * Remembers whether the consumer has joined its group (received an assignment, possibly
 * empty when there are more replicas than partitions). Before that, `run()` has resolved but
 * nothing is being consumed, so readiness must not say "up".
 */
@Injectable()
export class KafkaGroupMembership {
  private joined = false;

  markJoined(): void {
    this.joined = true;
  }

  hasJoined(): boolean {
    return this.joined;
  }
}
