/** Wall-clock milliseconds for in-process cache expiry (injected so tests control time). */
export abstract class CatalogClock {
  abstract nowMs(): number;
}
