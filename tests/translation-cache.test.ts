import { describe, expect, it, vi } from 'vitest';
import { cacheKey, translateCached, type CacheStore } from '../src/background/cache';
import type { SegmentInput, SegmentResult } from '../src/shared/messages';

const memory = (): CacheStore & { rows: Map<string, string> } => {
  const rows = new Map<string, string>();
  return {
    rows,
    get: async (keys) => new Map(keys.flatMap((k) => (rows.has(k) ? [[k, rows.get(k)!] as [string, string]] : []))),
    put: async (entries) => entries.forEach(([k, t]) => rows.set(k, t)),
  };
};
const segs: SegmentInput[] = [{ id: 'a', text: 'Hello there, world.' }, { id: 'b', text: 'Another paragraph.' }];
const fake = vi.fn(async (s: SegmentInput[]): Promise<SegmentResult[]> => s.map((x) => ({ id: x.id, ok: true, text: `译:${x.text}` })));

describe('translation cache', () => {
  it('translates what it has not seen, keeps it, and answers the same paragraphs from itself the second time', async () => {
    const store = memory();
    fake.mockClear();
    const first = await translateCached(segs, 'google-free', 'zh-CN', store, fake);
    await new Promise((r) => setTimeout(r, 0));
    expect(fake).toHaveBeenCalledTimes(1);
    expect(store.rows.size).toBe(2);
    const second = await translateCached(segs, 'google-free', 'zh-CN', store, fake);
    expect(fake).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it('asks only for the paragraphs that are missing, and returns everything in the original order', async () => {
    const store = memory();
    await translateCached([segs[1]!], 'google-free', 'zh-CN', store, fake);
    await new Promise((r) => setTimeout(r, 0));
    fake.mockClear();
    const out = await translateCached(segs, 'google-free', 'zh-CN', store, fake);
    expect(fake).toHaveBeenCalledWith([segs[0]]);
    expect(out.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('keeps engines and languages apart, and never stores a failure or the original text', async () => {
    const store = memory();
    await translateCached(segs, 'google-free', 'zh-CN', store, fake);
    fake.mockClear();
    await translateCached(segs, 'microsoft', 'zh-CN', store, fake);
    await translateCached(segs, 'google-free', 'ja', store, fake);
    expect(fake).toHaveBeenCalledTimes(2);
    const failing = memory();
    await translateCached(segs, 'google-free', 'zh-CN', failing, async (s) => s.map((x) => ({ id: x.id, ok: false as const, error: 'NETWORK' as const })));
    await new Promise((r) => setTimeout(r, 0));
    expect(failing.rows.size).toBe(0);
    expect([...store.rows.keys()].every((k) => /^[0-9a-f]{64}$/.test(k))).toBe(true);
    expect(await cacheKey('x', 'y', 'z')).toHaveLength(64);
  });

  it('does without the cache when it is off or broken', async () => {
    fake.mockClear();
    await translateCached(segs, 'google-free', 'zh-CN', null, fake);
    const broken: CacheStore = { get: async () => { throw new Error('no disk'); }, put: async () => {} };
    const out = await translateCached(segs, 'google-free', 'zh-CN', broken, fake);
    expect(fake).toHaveBeenCalledTimes(2);
    expect(out).toHaveLength(2);
  });
});

describe('caching across a fallback chain', () => {
  it('writes under the engine that actually answered, so switching back to the requested one later does not see it', async () => {
    const store = memory();
    const usedBy = new Map([['a', 'google-free']]);
    // Asked as "microsoft", but microsoft failed and google-free answered instead.
    await translateCached(
      [segs[0]!], 'microsoft', 'zh-CN', store,
      async (s) => s.map((x) => ({ id: x.id, ok: true as const, text: `译:${x.text}` })),
      (id) => usedBy.get(id) ?? 'microsoft',
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(store.rows.size).toBe(1);
    const googleKey = await cacheKey('google-free', 'zh-CN', segs[0]!.text);
    const microsoftKey = await cacheKey('microsoft', 'zh-CN', segs[0]!.text);
    expect(store.rows.has(googleKey)).toBe(true);
    expect(store.rows.has(microsoftKey)).toBe(false);

    // A later request that again names microsoft, with no onUsed override this time (microsoft now answers for
    // itself), must not see the stale google-free entry under a different key — and does not, because it was
    // never written under 'microsoft'.
    const fresh = vi.fn(async (s: SegmentInput[]) => s.map((x) => ({ id: x.id, ok: true as const, text: `微软:${x.text}` })));
    const out = await translateCached([segs[0]!], 'microsoft', 'zh-CN', store, fresh);
    expect(fresh).toHaveBeenCalledTimes(1);
    expect(out[0]).toMatchObject({ ok: true, text: '微软:Hello there, world.' });
  });
});
