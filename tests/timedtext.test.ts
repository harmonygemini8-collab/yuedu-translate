import { describe, expect, it } from 'vitest';
import { parseTimedText } from '../src/content/timedtext';

const file = (events: unknown[]) => JSON.stringify({ wireMagic: 'pb3', events });

describe('parseTimedText', () => {
  it('reads a caption file written by people: one line per event, with its own times', () => {
    const cues = parseTimedText(
      file([
        { tStartMs: 18640, dDurationMs: 3240, segs: [{ utf8: 'We are no strangers' }] },
        { tStartMs: 22640, dDurationMs: 4320, segs: [{ utf8: 'You know the rules' }, { utf8: ' and so do I' }] },
        { tStartMs: 30000, dDurationMs: 1000, segs: [{ utf8: '\n' }] },
      ]),
      '',
    );
    expect(cues).toEqual([
      { start: 18640, end: 21880, text: 'We are no strangers' },
      { start: 22640, end: 26960, text: 'You know the rules and so do I' },
    ]);
  });

  it('cuts automatic captions into sentences at the end punctuation and at pauses', () => {
    const word = (t: number, utf8: string) => ({ tStartMs: t, segs: [{ utf8 }] });
    const cues = parseTimedText(
      file([
        { tStartMs: 1000, dDurationMs: 4000, segs: [{ utf8: 'this' }, { utf8: ' is', tOffsetMs: 300 }, { utf8: ' it.', tOffsetMs: 600 }, { utf8: ' now', tOffsetMs: 900 }, { utf8: ' we', tOffsetMs: 1200 }] },
        { tStartMs: 2300, dDurationMs: 500, segs: [{ utf8: '\n' }] },
        // A pause of three seconds ends the sentence even without punctuation.
        word(6000, 'next'),
        word(6300, 'thing'),
      ]),
      'asr',
    );
    expect(cues.map((c) => c.text)).toEqual(['this is it.', 'now we', 'next thing']);
    expect(cues[0]).toMatchObject({ start: 1000 });
    // Timing is the time the words were spoken, not when the file's event began.
    expect(cues[1]).toMatchObject({ start: 1900 });
  });

  it('keeps a cue from overlapping the next one and cuts very long runs', () => {
    const words = Array.from({ length: 60 }, (_, i) => ({ utf8: ` word${i}`, tOffsetMs: i * 200 }));
    const cues = parseTimedText(file([{ tStartMs: 0, dDurationMs: 12000, segs: words }]), 'asr');
    expect(cues.length).toBeGreaterThan(1);
    for (let i = 0; i < cues.length - 1; i++) expect(cues[i]!.end).toBeLessThanOrEqual(cues[i + 1]!.start);
    for (const cue of cues) expect(cue.text.length).toBeLessThan(130);
  });

  it('puts no spaces between Chinese or Japanese words', () => {
    const cues = parseTimedText(file([{ tStartMs: 0, segs: [{ utf8: '你好' }, { utf8: '世界', tOffsetMs: 300 }, { utf8: '。', tOffsetMs: 600 }] }]), 'asr');
    expect(cues.map((c) => c.text)).toEqual(['你好世界。']);
  });

  it('ignores a body that is not a caption file', () => {
    expect(parseTimedText('', '')).toEqual([]);
    expect(parseTimedText('<xml/>', 'asr')).toEqual([]);
    expect(parseTimedText('{"events": 3}', '')).toEqual([]);
    expect(parseTimedText(file([{ segs: [{ utf8: 'no time' }] }, null]), '')).toEqual([]);
  });
});
