import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_GLOSSARY,
  clearGlossary,
  glossaryMapFor,
  loadGlossary,
  removeTerm,
  sanitizeGlossary,
  saveTerm,
} from '../src/shared/glossary';

function stubStorage() {
  const data: Record<string, unknown> = {};
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: data[key] })),
        set: vi.fn(async (items: Record<string, unknown>) => void Object.assign(data, items)),
        remove: vi.fn(async (key: string) => void delete data[key]),
      },
    },
  });
  return { data };
}

describe('glossary', () => {
  beforeEach(() => void stubStorage());

  it('adds a term, updates it in place on a second save for the same word and language, and is case-insensitive', async () => {
    expect(await saveTerm({ term: 'tokenizer', translation: '分词器', lang: 'zh-CN' }, 1000)).toBe('added');
    expect(await saveTerm({ term: 'Tokenizer', translation: '分词工具', lang: 'zh-CN' }, 2000)).toBe('updated');
    const all = await loadGlossary();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ term: 'tokenizer', translation: '分词工具' });
  });

  it('keeps the same term separate per target language', async () => {
    await saveTerm({ term: 'tokenizer', translation: '分词器', lang: 'zh-CN' }, 1000);
    await saveTerm({ term: 'tokenizer', translation: 'トークナイザー', lang: 'ja' }, 2000);
    expect((await loadGlossary()).map((e) => e.lang)).toEqual(expect.arrayContaining(['zh-CN', 'ja']));
    expect(await glossaryMapFor('zh-CN')).toEqual(new Map([['tokenizer', '分词器']]));
    expect(await glossaryMapFor('ja')).toEqual(new Map([['tokenizer', 'トークナイザー']]));
  });

  it('removes one term, clears the list, and stops at its limit', async () => {
    await saveTerm({ term: 'a', translation: 'x', lang: 'zh-CN' }, 1);
    await saveTerm({ term: 'b', translation: 'y', lang: 'zh-CN' }, 2);
    const [first] = await loadGlossary();
    await removeTerm(first!.id);
    expect((await loadGlossary()).map((e) => e.term)).toEqual(['a']);
    await clearGlossary();
    expect(await loadGlossary()).toEqual([]);
    const { data } = stubStorage();
    data['glossary'] = Array.from({ length: MAX_GLOSSARY }, (_, i) => ({ id: `i${i}`, term: `t${i}`, translation: 'x', lang: 'zh-CN', at: i }));
    expect(await saveTerm({ term: 'one-more', translation: 'x', lang: 'zh-CN' })).toBe('full');
  });

  it('reads storage as untrusted: drops what is not an entry and cuts what is too long', () => {
    const out = sanitizeGlossary([
      { id: 'a', term: 'ok', translation: 'good', lang: 'zh-CN', at: 1 },
      { id: 'b', term: '', translation: 'x', lang: 'zh-CN', at: 1 },
      'junk',
      { id: 'c', term: 'no-lang', translation: 'x', at: 1 },
      { id: 'd', term: 'x'.repeat(200), translation: 'y', lang: 'zh-CN', at: 1 },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]!.term).toBe('ok');
    expect(out[1]!.term).toHaveLength(100);
    expect(sanitizeGlossary('nope')).toEqual([]);
  });
});
