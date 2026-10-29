import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_VOCAB,
  clearVocab,
  dueWords,
  gradeWord,
  hasWord,
  loadVocab,
  pageOf,
  removeWord,
  sanitizeVocab,
  saveWord,
  toAnkiText,
  toCsv,
  updateVocabBadge,
  type VocabEntry,
} from '../src/shared/vocab';

function stubStorage() {
  const data: Record<string, unknown> = {};
  const action = { setBadgeText: vi.fn(async () => {}), setBadgeBackgroundColor: vi.fn(async () => {}) };
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: data[key] })),
        set: vi.fn(async (items: Record<string, unknown>) => void Object.assign(data, items)),
        remove: vi.fn(async (key: string) => void delete data[key]),
      },
    },
    action,
  });
  return { data, action };
}

const word = (text: string, extra: Partial<VocabEntry> = {}) => ({ text, translation: `译:${text}`, ...extra });

describe('word book', () => {
  beforeEach(() => void stubStorage());

  it('keeps a word once, newest first, and finds it again whatever the case', async () => {
    expect(await saveWord(word('spent'), 1000)).toBe('added');
    expect(await saveWord(word('Spent'), 2000)).toBe('exists');
    expect(await saveWord(word('ledger'), 3000)).toBe('added');
    expect((await loadVocab()).map((e) => e.text)).toEqual(['ledger', 'spent']);
    expect(await hasWord('SPENT')).toBe(true);
    expect(await hasWord('absent')).toBe(false);
  });

  it('removes one word, clears the book, and stops at its limit', async () => {
    await saveWord(word('a'), 1);
    await saveWord(word('b'), 2);
    const [first] = await loadVocab();
    await removeWord(first!.id);
    expect((await loadVocab()).map((e) => e.text)).toEqual(['a']);
    await clearVocab();
    expect(await loadVocab()).toEqual([]);
    const { data } = stubStorage();
    data['vocab'] = Array.from({ length: MAX_VOCAB }, (_, i) => ({ id: `i${i}`, text: `w${i}`, translation: 't', at: i }));
    expect(await saveWord(word('one-more'))).toBe('full');
  });

  it('reads storage as untrusted: drops what is not an entry and cuts what is too long', () => {
    const out = sanitizeVocab([
      { id: 'a', text: 'ok', translation: 'good', at: 1, senses: [{ pos: 'n', meaning: 'x' }, { pos: 1 }], context: 'c'.repeat(900) },
      { id: 'b', text: '', translation: 'x', at: 1 },
      'junk',
      { id: 'c', text: 'no-time', translation: 'x' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.senses).toEqual([{ pos: 'n', meaning: 'x' }]);
    expect(out[0]!.context).toHaveLength(500);
    expect(sanitizeVocab('nope')).toEqual([]);
  });

  it('writes a CSV a spreadsheet can open safely', () => {
    const csv = toCsv([
      { id: '1', text: '=HYPERLINK("http://x")', translation: '花,费', phonetic: '/s/', senses: [{ pos: 'v', meaning: 'pay' }], context: 'He "spent"\nit.', page: 'https://a.b/c', at: Date.UTC(2026, 9, 29) },
    ]);
    expect(csv.startsWith('\uFEFFword,phonetic,translation,meanings,sentence,page,date\r\n')).toBe(true);
    const row = csv.split('\r\n')[1]!;
    expect(row).toContain("\"'=HYPERLINK(\"\"http://x\"\")\"");
    expect(row).toContain('"花,费"');
    expect(row).toContain('"He ""spent"" it."');
    expect(row.endsWith('2026-10-29')).toBe(true);
  });

  it('keeps only the address of a page, without the query', () => {
    expect(pageOf('https://example.com/a/b?token=1#x')).toBe('https://example.com/a/b');
    expect(pageOf('chrome://extensions')).toBeUndefined();
    expect(pageOf('nonsense')).toBeUndefined();
  });

  it('writes an Anki-ready tab-separated file with the auto-config header, HTML-safe and tab-free fields', () => {
    const text = toAnkiText([
      { id: '1', text: 'spent', phonetic: '/spent/', translation: '花费', senses: [{ pos: 'v', meaning: '度过' }], context: 'He "spent"\ttime.', at: 1 },
    ]);
    const lines = text.trimEnd().split('\n');
    expect(lines.slice(0, 4)).toEqual(['#separator:tab', '#html:true', '#notetype:Basic', '#columns:Front\tBack']);
    const row = lines[4]!;
    expect(row.split('\t')).toHaveLength(2);
    expect(row).toContain('spent <span style="color:#888">/spent/</span>');
    expect(row).toContain('花费<br>v 度过<br><i>He "spent" time.</i>');
  });
});

describe('spaced repetition', () => {
  beforeEach(() => void stubStorage());

  it('is due immediately when saved, and keeps that until reviewed', async () => {
    const now = 10_000;
    await saveWord(word('spent'), now);
    const [entry] = await loadVocab();
    expect(entry!.schedule).toMatchObject({ due: now, interval: 0, reps: 0 });
    expect(dueWords(await loadVocab(), now)).toHaveLength(1);
    expect(dueWords(await loadVocab(), now - 1)).toHaveLength(0);
  });

  it('orders due words oldest-due first, and excludes ones not yet due', async () => {
    await saveWord(word('b'), 200);
    await saveWord(word('a'), 100);
    const all = await loadVocab();
    await gradeWord(all.find((e) => e.text === 'b')!.id, 'good', 100); // pushes b's due date out
    const due = dueWords(await loadVocab(), 150);
    expect(due.map((e) => e.text)).toEqual(['a']);
  });

  it('reschedules the right word, leaves the rest untouched, and reports a missing id as null', async () => {
    await saveWord(word('spent'), 1000);
    await saveWord(word('ledger'), 2000);
    const [first, second] = await loadVocab();
    const updated = await gradeWord(first!.id, 'good', 5000);
    expect(updated!.schedule).toMatchObject({ interval: 1, reps: 1 });
    expect(updated!.schedule!.due).toBe(5000 + 24 * 3600 * 1000);
    const after = await loadVocab();
    expect(after.find((e) => e.id === second!.id)!.schedule).toEqual(second!.schedule);
    expect(await gradeWord('does-not-exist', 'good')).toBeNull();
  });

  it('reads an entry saved before spaced repetition existed as due now', () => {
    const [entry] = sanitizeVocab([{ id: 'old', text: 'legacy', translation: 'x', at: 500 }]);
    expect(entry!.schedule).toBeDefined();
    expect(dueWords([entry!], 999_999)).toHaveLength(1);
  });

  it('sets the toolbar badge to the due count, and clears it at zero', async () => {
    const { action } = stubStorage();
    await saveWord(word('a'), 1);
    await saveWord(word('b'), 2);
    await updateVocabBadge();
    expect(action.setBadgeText).toHaveBeenLastCalledWith({ text: '2' });
    const all = await loadVocab();
    await gradeWord(all[0]!.id, 'good');
    await gradeWord(all[1]!.id, 'good');
    await updateVocabBadge();
    expect(action.setBadgeText).toHaveBeenLastCalledWith({ text: '' });
  });

  it('does nothing when there is no action API to set a badge on', async () => {
    const { data } = stubStorage();
    vi.stubGlobal('chrome', { storage: { local: { get: vi.fn(async (key: string) => ({ [key]: data[key] })) } } });
    await expect(updateVocabBadge()).resolves.toBeUndefined();
  });
});
