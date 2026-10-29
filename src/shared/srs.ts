/**
 * A simplified SM-2 schedule for the word book (doc/25 §1.2 "生词复习"). Two grades only — remembered it, or
 * didn't — rather than Anki's four, which keeps the review screen to two buttons. A new word is due immediately,
 * so starring it in the lookup bubble is enough to put it into rotation without a separate step.
 */

export interface Schedule {
  /** Epoch ms the word is next due. */
  due: number;
  /** Days until the next review, once it stops being "new". */
  interval: number;
  /** SM-2's ease factor; what `interval` is multiplied by each time the word is remembered. */
  ease: number;
  /** Reviews passed in a row without "forgot". */
  reps: number;
}

export const DEFAULT_SCHEDULE = (now = Date.now()): Schedule => ({ due: now, interval: 0, ease: 2.5, reps: 0 });

const DAY_MS = 24 * 3600 * 1000;
const MIN_EASE = 1.3;

export type Grade = 'again' | 'good';

/** The next schedule after one review. `again` restarts the ladder; `good` climbs it (1 day, then 6, then `interval * ease`). */
export function nextSchedule(current: Schedule, grade: Grade, now = Date.now()): Schedule {
  if (grade === 'again') {
    return { due: now + DAY_MS, interval: 1, ease: Math.max(MIN_EASE, current.ease - 0.2), reps: 0 };
  }
  const interval = current.reps === 0 ? 1 : current.reps === 1 ? 6 : Math.round(current.interval * current.ease);
  return { due: now + interval * DAY_MS, interval, ease: Math.min(3, current.ease + 0.05), reps: current.reps + 1 };
}

export const isDue = (schedule: Schedule | undefined, now = Date.now()): boolean => (schedule?.due ?? 0) <= now;
