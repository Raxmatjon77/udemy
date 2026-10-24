/**
 * The server's clock for progress (plausibility budgets, heartbeat times, flush claims).
 * Injected so tests drive time explicitly instead of sleeping.
 */
export abstract class LearningClock {
  /** Milliseconds since the epoch. */
  abstract nowMs(): number;
}
