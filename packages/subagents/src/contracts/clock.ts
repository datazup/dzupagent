/**
 * Injectable time source. Deterministic paths must depend on this rather than
 * `Date.now()` so tests can control time without real timers and so the runtime
 * is replay-safe.
 */
export interface Clock {
  now(): number;
}

/** Default production clock backed by the wall clock. */
export const systemClock: Clock = {
  now: () => Date.now(),
};
