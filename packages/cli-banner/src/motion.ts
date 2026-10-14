/**
 * How the mark moves.
 *
 * A thing that physically spins does not ease like a page transition — it
 * spins UP, turns at a steady rate, then slows to a stop. That is a TRAPEZOIDAL
 * velocity profile (ramp → cruise → ramp-down), and the long cruise in the
 * middle is the whole point: most of the animation runs at one constant speed,
 * so it reads as an object rotating rather than as a UI element animating.
 */

/** Fraction of the run spent getting up to speed. */
const ACCEL = 0.16;
/** Fraction spent slowing to a stop. Longer than the ramp so it settles. */
const DECEL = 0.3;

/** Area under the velocity trapezoid — used to normalise position to end at 1. */
const TOTAL_AREA = ACCEL / 2 + (1 - ACCEL - DECEL) + DECEL / 2;

/**
 * Fraction of the total rotation completed at time `t` (0..1).
 *
 * This is the integral of the velocity trapezoid, normalised so
 * `progress(1) === 1`. That normalisation is what lets a caller say "turn
 * exactly this far and land here" — without it the mark stops wherever the
 * maths happened to leave it, which for a logo can be an unflattering edge-on
 * pose.
 */
export function progress(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  let area: number;

  if (c < ACCEL) {
    // Ramping: area under a line rising from 0.
    area = (c * c) / (2 * ACCEL);
  } else if (c <= 1 - DECEL) {
    // Cruising at unit velocity.
    area = ACCEL / 2 + (c - ACCEL);
  } else {
    // Ramping down: the full area minus the triangle still to come.
    const left = 1 - c;
    area = ACCEL / 2 + (1 - ACCEL - DECEL) + (DECEL / 2 - (left * left) / (2 * DECEL));
  }

  return area / TOTAL_AREA;
}

/**
 * Velocity at time `t`, relative to cruise speed. Exported so the shape of the
 * motion can be asserted in tests rather than eyeballed on screen.
 */
export function velocity(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  if (c < ACCEL) return c / ACCEL;
  if (c <= 1 - DECEL) return 1;
  return (1 - c) / DECEL;
}

/** Where the cruise band begins and ends, for tests and for tuning. */
export const CRUISE = { from: ACCEL, to: 1 - DECEL };
