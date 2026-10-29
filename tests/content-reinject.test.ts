import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Minimal stand-in for the extension APIs a content script uses. */
function fakeChrome() {
  const listeners: ((msg: unknown, sender: unknown, respond: (r: unknown) => void) => unknown)[] = [];
  const runtime = {
    id: 'ext-1' as string | undefined,
    sendMessage: vi.fn(async (_message: unknown) => undefined),
    onMessage: { addListener: (fn: (typeof listeners)[number]) => listeners.push(fn) },
  };
  const api = {
    runtime,
    storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: { addListener: () => {} } },
  };
  return { api, runtime, listeners };
}

async function inject() {
  vi.resetModules();
  await import('../src/content/index');
}

describe('content script injection', () => {
  beforeEach(() => {
    delete window.__yilin;
    document.body.innerHTML = '<p>Hello world</p>';
  });

  // An instance left translating would keep its observers alive past the end of the test.
  afterEach(() => {
    window.__yilin?.dispose();
    delete window.__yilin;
  });

  it('starts on its own for a site on the auto-translate list', async () => {
    const chromeApi = fakeChrome();
    chromeApi.api.storage.local.get = async () => ({ autoTranslateSites: ['localhost'] });
    vi.stubGlobal('chrome', chromeApi.api);
    await inject();

    await vi.waitFor(() => {
      const sent = chromeApi.runtime.sendMessage.mock.calls.map(([m]) => (m as { type?: string })?.type);
      expect(sent).toContain('TRANSLATE_BATCH');
    });
  });

  it('stays idle on an auto-translate site that already is in the target language', async () => {
    const chromeApi = fakeChrome();
    chromeApi.api.storage.local.get = async () => ({ autoTranslateSites: ['localhost'], targetLang: 'zh-CN' });
    document.documentElement.lang = 'zh-CN';
    vi.stubGlobal('chrome', chromeApi.api);
    try {
      await inject();
      await new Promise((resolve) => setTimeout(resolve, 60));
      const sent = chromeApi.runtime.sendMessage.mock.calls.map(([m]) => (m as { type?: string })?.type);
      expect(sent).not.toContain('TRANSLATE_BATCH');
    } finally {
      document.documentElement.removeAttribute('lang');
    }
  });

  it('does not start on a site that is not on the list', async () => {
    const chromeApi = fakeChrome();
    vi.stubGlobal('chrome', chromeApi.api);
    await inject();
    await new Promise((resolve) => setTimeout(resolve, 60));
    const sent = chromeApi.runtime.sendMessage.mock.calls.map(([m]) => (m as { type?: string })?.type);
    expect(sent).not.toContain('TRANSLATE_BATCH');
  });

  it('does not start a second instance while the first one is alive', async () => {
    const first = fakeChrome();
    vi.stubGlobal('chrome', first.api);
    await inject();
    const instance = window.__yilin;
    await inject();
    expect(window.__yilin).toBe(instance);
    expect(first.listeners).toHaveLength(1);
  });

  it('replaces an instance orphaned by an extension reload and cleans its DOM', async () => {
    const old = fakeChrome();
    vi.stubGlobal('chrome', old.api);
    await inject();
    const oldInstance = window.__yilin!;
    // Leftovers from the old instance's translations.
    document.querySelector('p')!.insertAdjacentHTML('beforeend', '<span data-yilin="translation">旧译文</span>');
    document.querySelector('p')!.setAttribute('data-yilin-id', 'y1');

    // Extension reloaded: the old runtime loses its id, a new runtime appears.
    old.runtime.id = undefined;
    expect(oldInstance.alive()).toBe(false);
    const fresh = fakeChrome();
    vi.stubGlobal('chrome', fresh.api);
    await inject();

    expect(window.__yilin).not.toBe(oldInstance);
    expect(window.__yilin!.alive()).toBe(true);
    expect(fresh.listeners).toHaveLength(1);
    expect(document.querySelector('[data-yilin="translation"]')).toBeNull();
    expect(document.querySelector('[data-yilin-id]')).toBeNull();
  });

  it('an orphaned instance stops talking to the extension instead of throwing', async () => {
    const old = fakeChrome();
    vi.stubGlobal('chrome', old.api);
    await inject();
    // What the script reported about itself while the extension was still there does not count.
    old.runtime.sendMessage.mockClear();
    old.runtime.id = undefined;
    old.runtime.sendMessage.mockImplementation(() => {
      throw new Error('Extension context invalidated.');
    });
    // Starting emits state and requests translations; with the context gone neither may reach sendMessage.
    const respond = vi.fn();
    old.listeners[0]!({ type: 'START' }, { id: undefined }, respond);
    await new Promise((r) => setTimeout(r, 100));
    expect(respond).toHaveBeenCalled();
    expect(old.runtime.sendMessage).not.toHaveBeenCalled();
    window.__yilin?.dispose();
  });
});
