/** A course-room invalidation hint (contracts `QaChangedEvent`, ids only). */
export interface QaHint {
  readonly courseId: string;
  readonly questionId: string;
  readonly lectureId: string | null;
}

/**
 * Post-commit `qa.changed` hints to the course room `c:{courseId}` (design D15/D17, §5
 * AskQuestion). Best effort: implementations never reject (a lost hint only delays a refetch;
 * clients also refetch on reconnect), and callers invoke it only after the commit.
 */
export abstract class QaHints {
  abstract changed(hint: QaHint): Promise<void>;
}
