// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { translateWithGoogleFree } from '../src/background/google-free';
import { effectiveEngine, needsBackend } from '../src/shared/api';

const segments = [
  { id: 'a', text: 'Hello world.' },
  { id: 'b', text: 'Good morning, how are you?' },
];

/** Mimics the endpoint: [[["译文", "原文", ...], ...], null, "en"] with one chunk per input line. */
const googleReply = (lines: string[]) =>
  new Response(JSON.stringify([lines.map((line, i) => [i === 0 ? line : `\n${line}`, 'src', null, null, 10]), null, 'en']));

describe('free Google engine', () => {
  it('translates a batch in one request, joined by newlines, without cookies', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => googleReply(['你好世界。', '早上好，你好吗？']));
    const results = await translateWithGoogleFree(segments, 'zh-CN', fetch);

    expect(results).toEqual([
      { id: 'a', ok: true, text: '你好世界。' },
      { id: 'b', ok: true, text: '早上好，你好吗？' },
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toMatch(/^https:\/\/translate\.googleapis\.com\/translate_a\/single\?client=gtx&sl=auto&tl=zh-CN&dt=t$/);
    expect(init!.method).toBe('POST');
    expect(init!.credentials).toBe('omit');
    expect((init!.body as URLSearchParams).get('q')).toBe('Hello world.\nGood morning, how are you?');
  });

  it('falls back to one request per segment when the line count does not match', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(googleReply(['合并后的一行']))
      .mockImplementation(async (_url, init) => googleReply([`译:${(init!.body as URLSearchParams).get('q')}`]));
    const results = await translateWithGoogleFree(segments, 'zh-CN', fetch);

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(results.map((r) => (r.ok ? r.text : r.error))).toEqual(['译:Hello world.', '译:Good morning, how are you?']);
  });

  it('marks individual failures in the fallback path without failing the whole batch', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(googleReply(['only one line']))
      .mockResolvedValueOnce(googleReply(['好']))
      .mockResolvedValueOnce(new Response('not json'));
    const results = await translateWithGoogleFree(segments, 'zh-CN', fetch);
    expect(results).toEqual([
      { id: 'a', ok: true, text: '好' },
      { id: 'b', ok: false, error: 'PROVIDER_UNAVAILABLE' },
    ]);
  });

  it('treats a redirect to Google\'s captcha page as rate limiting instead of following it', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      // What Chrome returns for redirect: 'manual' (status 0, type "opaqueredirect").
      const r = new Response(null, { status: 200 });
      Object.defineProperty(r, 'type', { value: 'opaqueredirect' });
      return r;
    });
    await expect(translateWithGoogleFree(segments, 'zh-CN', fetch)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(fetch.mock.calls[0]![1]!.redirect).toBe('manual');
    // Some fetch implementations expose the 302 itself.
    await expect(translateWithGoogleFree(segments, 'zh-CN', async () => new Response(null, { status: 302 }))).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('maps rate limiting and network failures to batch-level errors', async () => {
    await expect(translateWithGoogleFree(segments, 'zh-CN', async () => new Response('', { status: 429 }))).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    await expect(translateWithGoogleFree(segments, 'zh-CN', async () => { throw new TypeError('blocked'); })).rejects.toMatchObject({ code: 'NETWORK' });
  });

  it('rejects unexpected response shapes', async () => {
    await expect(translateWithGoogleFree([segments[0]!], 'zh-CN', async () => new Response('{"error":1}'))).resolves.toEqual([
      { id: 'a', ok: false, error: 'PROVIDER_UNAVAILABLE' },
    ]);
  });
});

describe('engine selection', () => {
  it('needs no backend for free Google and falls back to it without one', () => {
    expect(needsBackend('google-free')).toBe(false);
    expect(needsBackend('microsoft')).toBe(true);
    expect(needsBackend('openai')).toBe(true);
    // Test builds have no backend baked in.
    expect(effectiveEngine('openai')).toBe('google-free');
    expect(effectiveEngine('google-free')).toBe('google-free');
  });

  it('turns a stored engine that no longer exists (the removed mock) into the default', async () => {
    const { sanitizeSettings } = await import('../src/shared/settings');
    expect(sanitizeSettings({ engine: 'mock' }).engine).toBe('google-free');
  });
});
