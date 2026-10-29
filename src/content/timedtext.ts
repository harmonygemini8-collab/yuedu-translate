/**
 * Reads the caption file a video player downloads (YouTube's `json3` format) into timed cues, so
 * every line can be translated ahead and shown at exactly the moment the player would show it.
 */

export interface Cue {
  /** Milliseconds from the start of the video. */
  start: number;
  end: number;
  text: string;
}

interface Json3Segment {
  utf8?: unknown;
  tOffsetMs?: unknown;
}

interface Json3Event {
  tStartMs?: unknown;
  dDurationMs?: unknown;
  segs?: unknown;
}

const clean = (text: string) => text.replace(/\s+/g, ' ').trim();
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const CJK = /[぀-ヿ㐀-鿿豈-﫿가-힯]/u;

/** Words of a spaced language are joined with a space; Chinese and Japanese have none to put back. */
function join(left: string, right: string): string {
  if (!left) return right;
  return CJK.test(left.at(-1)!) || CJK.test(right[0]!) ? left + right : `${left} ${right}`;
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object';

function segmentsOf(event: Json3Event): Json3Segment[] {
  return Array.isArray(event.segs) ? (event.segs as unknown[]).filter(isObject) : [];
}

/** A caption file written by people: one event is one line, with its own start and duration. */
function plainCues(events: Json3Event[]): Cue[] {
  const cues: Cue[] = [];
  for (const event of events) {
    if (!isNumber(event.tStartMs)) continue;
    const text = clean(segmentsOf(event).map((s) => (typeof s.utf8 === 'string' ? s.utf8 : '')).join(''));
    if (!text) continue;
    const duration = isNumber(event.dDurationMs) && event.dDurationMs > 0 ? event.dDurationMs : 2000;
    cues.push({ start: event.tStartMs, end: event.tStartMs + duration, text });
  }
  return cues;
}

/** A pause this long ends a sentence, spoken or not (a real file pauses about 0.9 s inside a sentence). */
const PAUSE_MS = 1200;
/** Two lines of subtitle; anything longer is cut at the next word. */
const MAX_CHARS = 110;
const MAX_CUE_MS = 7000;
/** The last word of a cue is still on screen this long after it is spoken. */
const LINGER_MS = 1200;
const SENTENCE_END = /[.!?。！？]["')\]」』]?$/u;

/**
 * Automatic captions come word by word, with the time each word is spoken and almost no
 * punctuation. They are cut into cues at sentence ends, at pauses, and at the length of two
 * lines, so each cue is a whole thought worth translating and its timing is the real one.
 */
function asrCues(events: Json3Event[]): Cue[] {
  const words: { start: number; text: string }[] = [];
  for (const event of events) {
    if (!isNumber(event.tStartMs)) continue;
    for (const seg of segmentsOf(event)) {
      if (typeof seg.utf8 !== 'string') continue;
      const text = clean(seg.utf8);
      if (!text) continue; // The newline markers between displayed lines.
      words.push({ start: event.tStartMs + (isNumber(seg.tOffsetMs) ? seg.tOffsetMs : 0), text });
    }
  }
  words.sort((a, b) => a.start - b.start);

  const cues: Cue[] = [];
  let current: { start: number; last: number; text: string } | undefined;
  const flush = () => {
    if (current?.text) cues.push({ start: current.start, end: current.last + LINGER_MS, text: current.text });
    current = undefined;
  };
  let previous: { start: number; text: string } | undefined;
  for (const word of words) {
    // Some files repeat a word in more than one event.
    if (previous && previous.start === word.start && previous.text === word.text) continue;
    previous = word;
    if (current && (word.start - current.last > PAUSE_MS || current.text.length >= MAX_CHARS || word.start - current.start > MAX_CUE_MS)) flush();
    current ??= { start: word.start, last: word.start, text: '' };
    current.text = join(current.text, word.text);
    current.last = word.start;
    if (SENTENCE_END.test(word.text)) flush();
  }
  flush();

  // A cue gives way to the next one rather than overlapping it.
  for (let i = 0; i < cues.length - 1; i++) cues[i]!.end = Math.min(cues[i]!.end, Math.max(cues[i + 1]!.start, cues[i]!.start + 1));
  return cues;
}

/** Cues of one caption file, or none when the body is not one we understand. */
export function parseTimedText(body: string, kind: string): Cue[] {
  let events: unknown;
  try {
    events = (JSON.parse(body) as { events?: unknown }).events;
  } catch {
    return [];
  }
  if (!Array.isArray(events)) return [];
  // The page can send anything here, so only well-formed events are looked at.
  const valid = (events as unknown[]).filter(isObject) as Json3Event[];
  return kind === 'asr' ? asrCues(valid) : plainCues(valid);
}
