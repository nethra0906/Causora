/**
 * INFRASTRUCTURE time (scheduling, deadlines, row timestamps). Deliberately separate from the
 * telemetry EVENT clock, which can be skewed by the `clock_offset` fault. One of only two places
 * allowed to call Date.now() (see test/unit/conventions.test.ts).
 */
export const wallMs = (): number => Date.now();
