/**
 * Slows down password guessing: after `max` failed attempts for the same key inside `windowMs`, further attempts are
 * refused until the window passes. In memory, so it resets when the server restarts and is per server process;
 * that is enough for one server, and a shared store is the upgrade path for several (see docs/HARDENING.md).
 */
export interface Throttle {
  /** Seconds to wait if the key is locked, else 0. */
  retryAfter(key: string): number;
  fail(key: string): void;
  succeed(key: string): void;
}

export function createThrottle(options: { max: number; windowMs: number; now?: () => number }): Throttle {
  const now = options.now ?? Date.now;
  const failures = new Map<string, number[]>();
  const recent = (key: string): number[] => {
    const cutoff = now() - options.windowMs;
    const list = (failures.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length === 0) failures.delete(key);
    else failures.set(key, list);
    return list;
  };
  return {
    retryAfter(key) {
      const list = recent(key);
      if (list.length < options.max) return 0;
      return Math.max(1, Math.ceil((list[0]! + options.windowMs - now()) / 1000));
    },
    fail(key) {
      const list = recent(key);
      list.push(now());
      failures.set(key, list);
      if (failures.size > 10_000) failures.delete(failures.keys().next().value as string); // bounded memory
    },
    succeed(key) {
      failures.delete(key);
    },
  };
}
