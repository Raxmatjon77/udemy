/**
 * A scriptable stand-in for XMLHttpRequest (part PUTs to MinIO). Each instance is recorded;
 * a test answers it with `respond(status)` / `fail()` and can emit upload progress.
 */
export class FakeXhr {
  static instances: FakeXhr[] = [];

  method = '';
  url = '';
  body: Blob | null = null;
  status = 0;
  withCredentials = true;
  aborted = false;
  /** Headers set by the code under test (must stay empty: the URL signs host + length only). */
  headers: Record<string, string> = {};
  upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;
  settled = false;

  constructor() {
    FakeXhr.instances.push(this);
  }

  static reset(): void {
    FakeXhr.instances = [];
  }

  /** Requests sent but not yet answered. */
  static pending(): FakeXhr[] {
    return FakeXhr.instances.filter((xhr) => xhr.body !== null && !xhr.settled);
  }

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string): void {
    this.headers[name.toLowerCase()] = value;
  }

  send(body: Blob): void {
    this.body = body;
  }

  abort(): void {
    if (this.settled) return;
    this.settled = true;
    this.aborted = true;
    this.onabort?.();
  }

  /** The part number from `...?partNumber=N` in the fake URL. */
  get partNumber(): number {
    return Number(new URL(this.url).searchParams.get('partNumber'));
  }

  progress(loaded: number): void {
    this.upload.onprogress?.({ loaded, total: this.body?.size ?? 0 } as ProgressEvent);
  }

  respond(status = 200): void {
    if (this.settled) return;
    this.settled = true;
    this.status = status;
    this.onload?.();
  }

  fail(): void {
    if (this.settled) return;
    this.settled = true;
    this.onerror?.();
  }
}

export const createFakeXhr = () => new FakeXhr() as unknown as XMLHttpRequest;
