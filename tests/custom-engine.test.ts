import { describe, expect, it, vi } from 'vitest';
import { chatUrl, parseArray, translateWithCustom } from '../src/background/custom-engine';
import { normalizeEndpoint, sanitizeSettings } from '../src/shared/settings';

const config = { baseUrl: 'https://api.example.com/v1', model: 'm', key: 'sk-test' };
const reply = (content: string, status = 200) => vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status }));
const segs = [{ id: 'a', text: 'Hello' }, { id: 'b', text: 'World [[1]]' }];

describe('own OpenAI-compatible service', () => {
  it('sends one request for the batch, with the key, and reads the array back', async () => {
    const fetcher = reply('["你好", "世界 [[1]]"]');
    const out = await translateWithCustom(segs, 'zh-CN', config, fetcher as unknown as typeof fetch);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example.com/v1/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
    expect(JSON.parse(init.body as string).messages[1].content).toBe(JSON.stringify(['Hello', 'World [[1]]']));
    expect(out.map((r) => r.ok && r.text)).toEqual(['你好', '世界 [[1]]']);
  });

  it('takes the array out of a code fence, and falls back to one request each when it is not an array', async () => {
    expect(parseArray('```json\n["a","b"]\n```', 2)).toEqual(['a', 'b']);
    expect(parseArray('["a"]', 2)).toBeNull();
    const calls: string[] = [];
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      calls.push(body.messages[1].content);
      return new Response(JSON.stringify({ choices: [{ message: { content: calls.length === 1 ? 'not json' : `译:${body.messages[1].content}` } }] }));
    });
    const out = await translateWithCustom(segs, 'zh-CN', config, fetcher as unknown as typeof fetch);
    expect(out.map((r) => r.ok && r.text)).toEqual(['译:Hello', '译:World [[1]]']);
  });

  it('maps the service answers to the extension errors, and sends no key when there is none', async () => {
    const code = async (status: number) => (await translateWithCustom(segs, 'zh-CN', config, reply('x', status) as unknown as typeof fetch))[0];
    expect(await code(401)).toMatchObject({ ok: false, error: 'NOT_CONFIGURED' });
    expect(await code(429)).toMatchObject({ ok: false, error: 'RATE_LIMITED' });
    expect(await code(404)).toMatchObject({ ok: false, error: 'INVALID_REQUEST' });
    expect(await code(500)).toMatchObject({ ok: false, error: 'PROVIDER_UNAVAILABLE' });
    const down = vi.fn(async () => { throw new TypeError('failed'); });
    expect((await translateWithCustom(segs, 'zh-CN', config, down as unknown as typeof fetch))[0]).toMatchObject({ error: 'NETWORK' });
    expect((await translateWithCustom(segs, 'zh-CN', { ...config, baseUrl: '' }))[0]).toMatchObject({ error: 'NOT_CONFIGURED' });
    const local = reply('["a","b"]');
    await translateWithCustom(segs, 'zh-CN', { baseUrl: 'http://localhost:11434/v1', model: 'qwen', key: '' }, local as unknown as typeof fetch);
    expect(((local.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('accepts https anywhere and http only on this machine, and never an address with a login in it', () => {
    expect(normalizeEndpoint('https://api.openai.com/v1/')).toBe('https://api.openai.com/v1');
    expect(normalizeEndpoint('http://localhost:11434/v1')).toBe('http://localhost:11434/v1');
    expect(normalizeEndpoint('http://127.0.0.1:1234/v1')).toBe('http://127.0.0.1:1234/v1');
    expect(normalizeEndpoint('http://example.com/v1')).toBe('');
    expect(normalizeEndpoint('https://user:pw@example.com/v1')).toBe('');
    expect(normalizeEndpoint('javascript:alert(1)')).toBe('');
    expect(sanitizeSettings({ customBaseUrl: 'ftp://x' }).customBaseUrl).toBe('');
    expect(chatUrl('https://a.b/v1')).toBe('https://a.b/v1/chat/completions');
    expect(chatUrl('https://a.b/v1/chat/completions')).toBe('https://a.b/v1/chat/completions');
    expect(chatUrl('https://api.openai.com/v1/models')).toBe('https://api.openai.com/v1/chat/completions');
  });
});

describe('dictionary entry from the reader\'s own service', () => {
  it('builds the entry a VIP would get, and refuses an answer with no translation', async () => {
    const { lookupWithCustom } = await import('../src/background/custom-engine');
    const fetcher = reply('```json\n{"translation":"花费","phonetic":"spent","senses":[{"pos":"动词","meaning":"花（时间）"}],"in_context":"这里指投入了时间","source_lang":"en"}\n```');
    const entry = await lookupWithCustom('spent', 'The firm spent eighteen months.', 'zh-CN', config, fetcher as unknown as typeof fetch);
    expect(entry).toMatchObject({ text: 'spent', translation: '花费', phonetic: 'spent', inContext: '这里指投入了时间', sourceLang: 'en', source: 'model' });
    expect(entry.senses).toEqual([{ pos: '动词', meaning: '花（时间）' }]);
    await expect(lookupWithCustom('x', '', 'zh-CN', config, reply('{"translation":""}') as unknown as typeof fetch)).rejects.toThrow();
  });
});

describe('browser-access header', () => {
  it('is sent to Anthropic and to no one else', async () => {
    const { testCustom } = await import('../src/background/custom-engine');
    const headersOf = async (baseUrl: string) => {
      const f = reply('OK');
      await testCustom({ ...config, baseUrl }, f as unknown as typeof fetch);
      return (f.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>;
    };
    expect((await headersOf('https://api.anthropic.com/v1'))['anthropic-dangerous-direct-browser-access']).toBe('true');
    expect((await headersOf('https://api.openai.com/v1'))['anthropic-dangerous-direct-browser-access']).toBeUndefined();
    expect((await headersOf('http://localhost:11434/v1'))['anthropic-dangerous-direct-browser-access']).toBeUndefined();
  });
});

describe('connection test', () => {
  it('reports what the service said, and what the browser said when it never got an answer', async () => {
    const { testCustom } = await import('../src/background/custom-engine');
    const said = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'The model `x` does not exist' } }), { status: 404 }));
    expect(await testCustom(config, said as unknown as typeof fetch)).toEqual({ ok: false, error: 'INVALID_REQUEST', detail: 'HTTP 404: The model `x` does not exist' });
    const down = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    expect(await testCustom(config, down as unknown as typeof fetch)).toEqual({ ok: false, error: 'NETWORK', detail: 'TypeError: Failed to fetch' });
    expect(await testCustom(config, reply('OK') as unknown as typeof fetch)).toEqual({ ok: true });
  });

  it('strips spaces and invisible characters from a pasted key', async () => {
    const { testCustom } = await import('../src/background/custom-engine');
    const f = reply('OK');
    await testCustom({ ...config, key: ' sk-abc\u200b123\n' }, f as unknown as typeof fetch);
    expect(((f.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>).Authorization).toBe('Bearer sk-abc123');
  });
});

describe('a model that only takes its default temperature', () => {
  it('is asked again without one, and not asked with one again', async () => {
    const { testCustom } = await import('../src/background/custom-engine');
    const cfg = { baseUrl: 'https://api.example.com/v9', model: 'reasoner', key: 'k' };
    const f = vi.fn(async (_url: string, init: RequestInit) =>
      'temperature' in JSON.parse(init.body as string)
        ? new Response(JSON.stringify({ error: { message: "Unsupported value: 'temperature' does not support 0 with this model." } }), { status: 400 })
        : new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] })));
    expect(await testCustom(cfg, f as unknown as typeof fetch)).toEqual({ ok: true });
    expect(f).toHaveBeenCalledTimes(2);
    await testCustom(cfg, f as unknown as typeof fetch);
    expect(f).toHaveBeenCalledTimes(3);
  });
});

describe('Claude through its OpenAI-compatible address', () => {
  it('is asked again without a temperature when the newer models refuse one below 1', async () => {
    const { testCustom } = await import('../src/background/custom-engine');
    const cfg = { baseUrl: 'https://api.anthropic.com/v1', model: 'claude-opus-5-5', key: 'sk-ant-x' };
    const f = vi.fn(async (_url: string, init: RequestInit) =>
      'temperature' in JSON.parse(init.body as string)
        ? new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: '`temperature` values below 1 are not supported for this model; omit it' } }), { status: 400 })
        : new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] })));
    expect(await testCustom(cfg, f as unknown as typeof fetch)).toEqual({ ok: true });
    expect(f.mock.calls[0]![0]).toBe('https://api.anthropic.com/v1/chat/completions');
    expect(((f.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>)['anthropic-dangerous-direct-browser-access']).toBe('true');
  });
});
