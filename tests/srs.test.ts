import { describe, expect, it } from 'vitest';
import { DEFAULT_SCHEDULE, isDue, nextSchedule } from '../src/shared/srs';

const DAY = 24 * 3600 * 1000;

describe('spaced repetition schedule', () => {
  it('is due the moment it is created', () => {
    const now = 1000;
    expect(isDue(DEFAULT_SCHEDULE(now), now)).toBe(true);
    expect(isDue(DEFAULT_SCHEDULE(now), now - 1)).toBe(false);
    // No schedule at all (an entry written before spaced repetition existed) reads as due, same as a fresh word.
    expect(isDue(undefined, now)).toBe(true);
  });

  it('climbs 1 day, then 6 days, then interval times ease when remembered', () => {
    const now = 0;
    let s = DEFAULT_SCHEDULE(now);
    s = nextSchedule(s, 'good', now);
    expect(s).toMatchObject({ interval: 1, reps: 1 });
    expect(s.due).toBe(now + DAY);

    s = nextSchedule(s, 'good', now);
    expect(s).toMatchObject({ interval: 6, reps: 2 });
    expect(s.due).toBe(now + 6 * DAY);

    const easeBefore = s.ease;
    s = nextSchedule(s, 'good', now);
    expect(s.interval).toBe(Math.round(6 * easeBefore));
    expect(s.reps).toBe(3);
  });

  it('restarts the ladder and lowers the ease when forgotten, never below 1.3', () => {
    const now = 0;
    let s = DEFAULT_SCHEDULE(now);
    s = nextSchedule(s, 'good', now);
    s = nextSchedule(s, 'good', now);
    const beforeAgain = s;
    s = nextSchedule(s, 'again', now);
    expect(s).toMatchObject({ interval: 1, reps: 0 });
    expect(s.due).toBe(now + DAY);
    expect(s.ease).toBeCloseTo(beforeAgain.ease - 0.2);

    // Hammer it with failures; the ease floors out instead of going negative or to zero.
    let floor = DEFAULT_SCHEDULE(now);
    for (let i = 0; i < 20; i++) floor = nextSchedule(floor, 'again', now);
    expect(floor.ease).toBe(1.3);
  });

  it('caps the ease so a long streak does not runaway accelerate forever', () => {
    let s = DEFAULT_SCHEDULE(0);
    for (let i = 0; i < 50; i++) s = nextSchedule(s, 'good', 0);
    expect(s.ease).toBeLessThanOrEqual(3);
  });
});
