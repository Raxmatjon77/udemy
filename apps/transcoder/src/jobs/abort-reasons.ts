/** The process is shutting down: release the lease without penalty. */
export class ShutdownAbort extends Error {
  constructor() {
    super('transcoder is shutting down');
    this.name = 'ShutdownAbort';
  }
}

/** The lease was reaped or re-leased: stop, discard outputs, write nothing. */
export class LeaseLostAbort extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'LeaseLostAbort';
  }
}
