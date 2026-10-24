import type { AfterCommitTask, HandlerContext } from '../messaging/event-handler.interface';

/**
 * A `HandlerContext` for calling `handle` directly in tests: it records after-commit tasks
 * instead of running them; `runAfterCommit()` plays them as the processor would after a commit.
 */
export interface RecordingHandlerContext extends HandlerContext {
  readonly tasks: readonly AfterCommitTask[];
  runAfterCommit(): Promise<void>;
}

export function testHandlerContext(): RecordingHandlerContext {
  const tasks: AfterCommitTask[] = [];
  return {
    tasks,
    afterCommit: (task) => {
      tasks.push(task);
    },
    runAfterCommit: async () => {
      for (const task of tasks) await task();
    },
  };
}
