import { describe, expect, it, vi } from 'vitest';
import { translateWithFallback, type EngineDeps } from '../src/background/engines';
import { looksRefused, looksTranslated } from '../src/shared/script';
import type { SegmentInput, SegmentResult } from '../src/shared/messages';
import type { EngineChoice } from '../src/shared/settings';

const segs: SegmentInput[] = [
  { id: 'a', text: 'The first paragraph is long enough to judge.' },
  { id: 'b', text: 'The second paragraph is long enough as well.' },
];

function deps(script: Partial<Record<EngineChoice, (s: SegmentInput[]) => SegmentResult[] | Error>>, signedIn = true): EngineDeps & { calls: EngineChoice[] } {
  const calls: EngineChoice[] = [];
  return {
    calls,
    run: vi.fn(async (engine: EngineChoice, batch: SegmentInput[]) => {
      calls.push(engine);
      const out = script[engine as EngineChoice]?.(batch) ?? new Error('NETWORK');
      if (out instanceof Error) throw out;
      return out;
    }),
    signedIn: async () => signedIn,
    errorCode: (err) => (err instanceof Error && err.message === 'RATE_LIMITED' ? 'RATE_LIMITED' : 'NETWORK'),
  };
}
const ok = (s: SegmentInput[], text = '译文') => s.map((x) => ({ id: x.id, ok: true as const, text: `${text}${x.id}` }));

describe('engine fallback', () => {
  it('uses the chosen engine and asks no other when it answers', async () => {
    const d = deps({ microsoft: (s) => ok(s) });
    const out = await translateWithFallback('microsoft', segs, 'zh-CN', true, d);
    expect(d.calls).toEqual(['microsoft']);
    expect(out.map((r) => r.ok && r.text)).toEqual(['译文a', '译文b']);
  });

  it('moves on to the next free engine when the first is refused, keeping the first error if all fail', async () => {
    const d = deps({ 'google-free': () => new Error('RATE_LIMITED'), microsoft: (s) => ok(s, '微软') });
    const out = await translateWithFallback('google-free', segs, 'zh-CN', true, d);
    expect(d.calls).toEqual(['google-free', 'microsoft']);
    expect(out.map((r) => r.ok && r.text)).toEqual(['微软a', '微软b']);
    const none = deps({ 'google-free': () => new Error('RATE_LIMITED') });
    const failed = await translateWithFallback('google-free', segs, 'zh-CN', true, none);
    expect(failed.every((r) => !r.ok && r.error === 'RATE_LIMITED')).toBe(true);
  });

  it('retries only the segments that failed', async () => {
    const d = deps({
      'google-free': (s) => [{ id: s[0]!.id, ok: true, text: '好' }, { id: s[1]!.id, ok: false, error: 'PROVIDER_UNAVAILABLE' }],
      microsoft: (s) => ok(s, '微'),
    });
    const out = await translateWithFallback('google-free', segs, 'zh-CN', true, d);
    expect(d.run).toHaveBeenLastCalledWith('microsoft', [segs[1]], 'zh-CN');
    expect(out.map((r) => r.ok && r.text)).toEqual(['好', '微b']);
  });

  it('treats an answer in the wrong language as a failure, and keeps it if nothing does better', async () => {
    const d = deps({ 'google-free': (s) => s.map((x) => ({ id: x.id, ok: true as const, text: x.text })), microsoft: (s) => ok(s, '微软') });
    const out = await translateWithFallback('google-free', segs, 'zh-CN', true, d);
    expect(out.map((r) => r.ok && r.text)).toEqual(['微软a', '微软b']);
    const same = deps({ 'google-free': (s) => s.map((x) => ({ id: x.id, ok: true as const, text: x.text })) });
    const kept = await translateWithFallback('google-free', segs, 'zh-CN', true, same);
    expect(kept.map((r) => r.ok && r.text)).toEqual([segs[0]!.text, segs[1]!.text]);
  });

  it('does nothing of the kind when it is switched off, or when the reader is not signed in for the server engines', async () => {
    const off = deps({ 'google-free': () => new Error('RATE_LIMITED'), microsoft: (s) => ok(s) });
    await translateWithFallback('google-free', segs, 'zh-CN', false, off);
    expect(off.calls).toEqual(['google-free']);
    const out = deps({ 'google-free': () => new Error('RATE_LIMITED'), microsoft: (s) => ok(s) }, false);
    await translateWithFallback('google-free', segs, 'zh-CN', true, out);
    expect(out.calls).toEqual(['google-free']);
  });

  it('treats a refusal as a failure, and keeps it if nothing does better', async () => {
    const d = deps({
      'google-free': (s) => s.map((x) => ({ id: x.id, ok: true as const, text: '很抱歉，我还未学习到如何回答这个问题的内容。' })),
      microsoft: (s) => ok(s, '微软'),
    });
    const out = await translateWithFallback('google-free', segs, 'zh-CN', true, d);
    expect(out.map((r) => r.ok && r.text)).toEqual(['微软a', '微软b']);
    const same = deps({
      'google-free': (s) => s.map((x) => ({ id: x.id, ok: true as const, text: "I'm sorry, but I can't help with that request." })),
    });
    const kept = await translateWithFallback('google-free', segs, 'zh-CN', true, same);
    expect(kept.every((r) => r.ok)).toBe(true);
    expect(kept[0]).toMatchObject({ ok: true, text: "I'm sorry, but I can't help with that request." });
  });

  it('never falls back to a paid engine, but does fall back from one', async () => {
    const d = deps({ openai: () => new Error('NETWORK'), 'google-free': (s) => ok(s, '谷') });
    const out = await translateWithFallback('openai', segs, 'zh-CN', true, d);
    expect(d.calls).toEqual(['openai', 'google-free']);
    expect(out[0]).toMatchObject({ ok: true, text: '谷a' });
  });
});

describe('looksTranslated', () => {
  it('judges by script, and only when there is something to judge', () => {
    expect(looksTranslated('The first paragraph is long enough.', '第一段足够长。', 'zh-CN')).toBe(true);
    expect(looksTranslated('The first paragraph is long enough.', 'The first paragraph is long enough.', 'zh-CN')).toBe(false);
    expect(looksTranslated('Eighteen', 'Eighteen', 'zh-CN')).toBe(true);
    expect(looksTranslated('The first paragraph is long enough.', 'Le premier paragraphe est assez long.', 'fr')).toBe(true);
    expect(looksTranslated('where [[1]] is the position of the token', '其中 [[1]] 是词元的位置', 'zh-CN')).toBe(true);
    expect(looksTranslated('The first paragraph is long enough.', 'Первый абзац достаточно длинный.', 'ru')).toBe(true);
    expect(looksTranslated('The first paragraph is long enough.', 'The first paragraph is long enough.', 'ru')).toBe(false);
  });
});

describe('looksRefused', () => {
  it('catches common refusal phrasings in English and Chinese, and leaves real translations alone', () => {
    expect(looksRefused('很抱歉，我还未学习到如何回答这个问题的内容。')).toBe(true);
    expect(looksRefused('抱歉，我无法回答这个问题。')).toBe(true);
    expect(looksRefused("I'm sorry, but I can't help with that request.")).toBe(true);
    expect(looksRefused('As an AI language model, I cannot provide that.')).toBe(true);
    expect(looksRefused('第一段足够长。')).toBe(false);
    expect(looksRefused('Sorry about the delay, the translation is below.')).toBe(false);
    expect(looksRefused('')).toBe(false);
  });
});

describe('reporting which engine actually answered', () => {
  it('calls onUsed with the engine that produced each accepted segment', async () => {
    const d = deps({ 'google-free': () => new Error('RATE_LIMITED'), microsoft: (s) => ok(s, '微软') });
    const used = new Map<string, string>();
    await translateWithFallback('google-free', segs, 'zh-CN', true, { ...d, onUsed: (id, engine) => used.set(id, engine) });
    expect([...used.values()]).toEqual(['microsoft', 'microsoft']);
  });

  it('never reports the requested engine for a segment it did not actually answer', async () => {
    const d = deps({
      'google-free': (s) => [{ id: s[0]!.id, ok: true, text: '好' }, { id: s[1]!.id, ok: false, error: 'PROVIDER_UNAVAILABLE' }],
      microsoft: (s) => ok(s, '微'),
    });
    const used = new Map<string, string>();
    await translateWithFallback('google-free', segs, 'zh-CN', true, { ...d, onUsed: (id, engine) => used.set(id, engine) });
    expect(used.get('a')).toBe('google-free');
    expect(used.get('b')).toBe('microsoft');
  });
});
