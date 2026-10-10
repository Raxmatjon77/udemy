import { z } from 'zod';
import { MediaPurposeSchema } from '@udemy/contracts';

/**
 * What survives a page reload of an unfinished upload (design §10 "Resume"): the asset, the file
 * identity (to recognise the same file when the user selects it again) and the parts confirmed
 * so far. Kept in `sessionStorage` (per tab, cleared with the tab), keyed by the upload slot
 * (`lecture:<id>`, `thumbnail:<courseId>`). The server stays authoritative: on resume the hook
 * asks `GET /media/uploads/:id` which parts S3 really has.
 */
export const UploadRecordSchema = z.object({
  assetId: z.string(),
  purpose: MediaPurposeSchema,
  name: z.string(),
  size: z.number().int().min(1),
  lastModified: z.number(),
  type: z.string(),
  partSize: z.number().int().min(1),
  partCount: z.number().int().min(1),
  uploadedParts: z.array(z.number().int().min(1)),
});
export type UploadRecord = z.infer<typeof UploadRecordSchema>;

export interface UploadStore {
  /** The raw stored string (a stable snapshot for `useSyncExternalStore`). */
  raw(slotKey: string): string | null;
  load(slotKey: string): UploadRecord | null;
  save(slotKey: string, record: UploadRecord): void;
  clear(slotKey: string): void;
  subscribe(listener: () => void): () => void;
}

const PREFIX = 'udemy:upload:';

export function parseUploadRecord(raw: string | null): UploadRecord | null {
  if (!raw) return null;
  try {
    const parsed = UploadRecordSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * A store over a Web Storage area. Storage can be missing (SSR) or throw (private mode, quota),
 * so every access is guarded; without storage, uploads still work but cannot resume.
 */
export function createUploadStore(storage: () => Storage | undefined): UploadStore {
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  const safe = <T>(fn: (s: Storage) => T, fallback: T): T => {
    try {
      const s = storage();
      return s ? fn(s) : fallback;
    } catch {
      return fallback;
    }
  };
  return {
    raw: (slotKey) => safe((s) => s.getItem(PREFIX + slotKey), null),
    load(slotKey) {
      return parseUploadRecord(this.raw(slotKey));
    },
    save(slotKey, record) {
      safe((s) => s.setItem(PREFIX + slotKey, JSON.stringify(record)), undefined);
      notify();
    },
    clear(slotKey) {
      safe((s) => s.removeItem(PREFIX + slotKey), undefined);
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The app-wide store (one per tab). */
export const sessionUploadStore = createUploadStore(() =>
  typeof window === 'undefined' ? undefined : window.sessionStorage,
);
