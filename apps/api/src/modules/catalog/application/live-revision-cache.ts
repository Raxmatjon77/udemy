import { Injectable } from '@nestjs/common';
import type { SnapshotQuiz } from '../domain/revision-snapshot';
import { CatalogClock } from './ports/catalog-clock';
import type { LiveCourseRecord } from './ports/public-catalog.repository';
import type { RevisionOutline } from './ports/revision.repository';

/** Revisions whose outline is kept (design §3: "LRU 500 revisions"). */
export const REVISION_OUTLINE_CACHE_SIZE = 500;
/** Quizzes (with their keys) kept, by (revision, lecture). */
export const REVISION_QUIZ_CACHE_SIZE = 1000;
/** Live pointers (course -> live revision) kept for the heartbeat hot path. */
export const LIVE_POINTER_CACHE_SIZE = 5000;
/** How long a live pointer is trusted (design §3 `getLiveLecture`: 30 s). */
export const LIVE_POINTER_TTL_MS = 30_000;

/** A bounded least-recently-used map (Map iteration order = insertion order). */
export class LruCache<K, V> {
  private readonly entries = new Map<K, V>();

  constructor(private readonly maxEntries: number) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError(`LruCache: maxEntries must be a positive integer (${maxEntries})`);
    }
  }

  get(key: K): V | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
  }

  delete(key: K): void {
    this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}

/** Freezes a plain data tree (arrays and objects), so a cached value can be shared safely. */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/**
 * The in-process caches behind the Phase 5 `CatalogFacade` reads (design §3, finding 2):
 *
 * - revision outlines and revision quizzes never change (revisions are append-only and written
 *   in one transaction), so they are cached without expiry, bounded by LRU size; values are
 *   deep-frozen and shared;
 * - the course -> live revision pointer DOES change (approve, archive, restore), so it is only
 *   trusted for `LIVE_POINTER_TTL_MS` (30 s), on the heartbeat hot path (`getLiveLecture`).
 *
 * Per process (one per API replica). Only ever filled from committed reads (callers that pass
 * a transaction bypass the pointer cache).
 */
@Injectable()
export class LiveRevisionCache {
  readonly outlines = new LruCache<string, RevisionOutline>(REVISION_OUTLINE_CACHE_SIZE);
  readonly quizzes = new LruCache<string, SnapshotQuiz>(REVISION_QUIZ_CACHE_SIZE);
  private readonly pointers = new LruCache<
    string,
    { readonly course: LiveCourseRecord; readonly expiresAt: number }
  >(LIVE_POINTER_CACHE_SIZE);

  constructor(private readonly clock: CatalogClock) {}

  static quizKey(revisionId: string, lectureId: string): string {
    return `${revisionId}:${lectureId}`;
  }

  /** The cached live pointer of a course if it is younger than the TTL. */
  livePointer(courseId: string): LiveCourseRecord | undefined {
    const entry = this.pointers.get(courseId);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.clock.nowMs()) {
      this.pointers.delete(courseId);
      return undefined;
    }
    return entry.course;
  }

  rememberLivePointer(course: LiveCourseRecord): void {
    this.pointers.set(course.id, {
      course: deepFreeze({ ...course }),
      expiresAt: this.clock.nowMs() + LIVE_POINTER_TTL_MS,
    });
  }

  /** Test support and memory pressure: drops everything. */
  clear(): void {
    this.outlines.clear();
    this.quizzes.clear();
    this.pointers.clear();
  }
}
