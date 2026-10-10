/**
 * Pads a code path to a minimum duration, so its response time does not reveal which branch
 * ran (design §9: signup and forgot-password have a fixed response-time floor).
 */
export abstract class ResponseTimeFloor {
  /** Runs `work`; settles (resolve or reject) no earlier than `minimumMs` after the call. */
  abstract run<T>(minimumMs: number, work: () => Promise<T>): Promise<T>;
}
