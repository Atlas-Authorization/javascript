/** The engine clock. Everything the engine stamps (ids, tokens, webhooks, windows) reads it. */
export interface Clock {
  now(): number;
  advance(ms: number): void;
  set(ms: number): void;
  reset(): void;
}

export function createClock(start?: () => number): Clock {
  const base = start ?? Date.now;
  let offset = 0;
  return {
    now: () => base() + offset,
    advance: (ms) => void (offset += ms),
    set: (ms) => void (offset = ms - base()),
    reset: () => void (offset = 0),
  };
}
