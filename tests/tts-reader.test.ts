// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArticleReader, wantsRemoteVoice } from '../src/content/tts';

const voice = (name: string, lang: string) => ({ name, lang }) as SpeechSynthesisVoice;
const EDGE = [voice('Microsoft Xiaoxiao Online (Natural) - Chinese (Mainland)', 'zh-CN')];
const CHROME = [voice('Google 普通话（中国大陆）', 'zh-CN')];

const spoken: string[] = [];
const played: number[] = [];

class FakeUtterance {
  lang = '';
  voice: unknown = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly text: string) {}
}

function install(voices: SpeechSynthesisVoice[]) {
  vi.stubGlobal('speechSynthesis', {
    getVoices: () => voices,
    cancel() {},
    addEventListener() {},
    speak(u: FakeUtterance) {
      spoken.push(u.text);
      queueMicrotask(() => u.onend?.());
    },
  });
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
  // jsdom cannot play media: the element path reports it and the reader falls back to Web Audio.
  vi.stubGlobal('Audio', class { loop = false; play() {} pause() {} });
  vi.stubGlobal('AudioContext', class {
    state = 'running';
    destination = {};
    resume = async () => {};
    decodeAudioData = async (b: ArrayBuffer) => ({ length: b.byteLength });
    createBufferSource() {
      const source = { buffer: null as unknown, onended: null as (() => void) | null, connect() {}, stop() {}, start() {
        played.push((source.buffer as { length: number }).length);
        queueMicrotask(() => source.onended?.());
      } };
      return source;
    }
  });
}

const translation = (text: string) =>
  `<span data-yilin="translation" data-state="done" lang="zh-CN">${text}</span>`;

function mount() {
  document.body.innerHTML = `<article><p>Hello${translation('第一句。第二句。')}</p></article>`;
}

async function readAll(speakRemote?: (text: string, lang: string) => Promise<ArrayBuffer | null>) {
  const reader = new ArticleReader(document, { isTranslating: () => false, onChange: () => {}, speakRemote });
  reader.start();
  await vi.waitFor(() => expect(reader.active).toBe(false), { timeout: 3000 });
}

describe('which voice reads', () => {
  beforeEach(() => {
    spoken.length = 0;
    played.length = 0;
    mount();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('asks the server only when the browser has no neural voice', () => {
    expect(wantsRemoteVoice(EDGE, 'zh-CN')).toBe(false);
    expect(wantsRemoteVoice(CHROME, 'zh-CN')).toBe(true);
    expect(wantsRemoteVoice([], 'zh-CN')).toBe(true);
  });

  it('Edge reads with its own natural voice and never contacts the server', async () => {
    install(EDGE);
    const remote = vi.fn(async () => new ArrayBuffer(8));
    await readAll(remote);
    expect(remote).not.toHaveBeenCalled();
    expect(spoken).toEqual(['第一句。第二句。']);
  });

  it('Chrome signed in plays the server voice and says nothing locally', async () => {
    install(CHROME);
    const remote = vi.fn(async () => new ArrayBuffer(8));
    await readAll(remote);
    expect(remote).toHaveBeenCalledWith('第一句。第二句。', 'zh-CN');
    expect(played).toEqual([8]);
    expect(spoken).toEqual([]);
  });

  it('falls back to the local voice when the server cannot help, and stops asking', async () => {
    document.body.innerHTML = `<article><p>A${translation('甲'.repeat(100) + '。' + '乙'.repeat(100) + '。')}</p></article>`;
    install(CHROME);
    const remote = vi.fn(async () => null);
    await readAll(remote);
    // Two pieces were read aloud locally; the server was tried at the start only (plus the prefetch of the next piece).
    expect(spoken).toHaveLength(2);
    expect(remote.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('works without any server voice configured', async () => {
    install(CHROME);
    await readAll(undefined);
    expect(spoken).toEqual(['第一句。第二句。']);
  });
});

describe('following the article down', () => {
  const rects = new Map<Element, { top: number; bottom: number }>();
  let scrollBy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    spoken.length = 0;
    rects.clear();
    install(EDGE);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const r = rects.get(this) ?? { top: 0, bottom: 0 };
      return { ...r, left: 0, right: 0, width: 0, height: r.bottom - r.top, x: 0, y: r.top, toJSON() {} } as DOMRect;
    });
    scrollBy = vi.fn();
    window.scrollBy = scrollBy as unknown as typeof window.scrollBy;
  });
  afterEach(() => vi.restoreAllMocks());

  const run = async (reader: ArticleReader) => {
    reader.start();
    await vi.waitFor(() => expect(reader.active).toBe(false), { timeout: 4000 });
  };
  const makeReader = () => new ArticleReader(document, { isTranslating: () => false, onChange: () => {}, settleMs: 5, userPauseMs: 60 });

  it('scrolls on to the end of this article and stops there, never into the next one', async () => {
    document.body.innerHTML = `<article id="a"><p>one${translation('甲段。')}</p></article>
      <article id="b"><p>next${translation('下一篇文章里译文更多更多更多。')}</p></article>`;
    const a = document.getElementById('a')!;
    rects.set(a, { top: 0, bottom: 1500 });
    let step = 0;
    scrollBy.mockImplementation(({ top }: { top: number }) => {
      const r = rects.get(a)!;
      r.bottom -= top;
      // The paragraph that was waiting below gets translated as it scrolls into view.
      if (++step === 1) a.insertAdjacentHTML('beforeend', `<p>two${translation('丙段。')}</p>`);
    });

    await run(makeReader());

    expect(spoken).toEqual(['甲段。', '丙段。']);
    const tops = scrollBy.mock.calls.map(([o]) => (o as { top: number }).top);
    // One screen at a time, then only the little that was left: the article's end, not a screen past it.
    expect(tops[0]).toBeCloseTo(768 * 0.85);
    expect(tops).toHaveLength(2);
    expect(tops[1]).toBeLessThan(100);
  });

  it('does not scroll on its own on a page with no article to measure against', async () => {
    document.body.innerHTML = `<div><p>one${translation('甲段。')}</p></div>`;
    await run(makeReader());
    expect(spoken).toEqual(['甲段。']);
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it('does not scroll through a feed of several articles', async () => {
    document.body.innerHTML = `<main><article><p>a${translation('甲。')}</p></article><article><p>b${translation('乙。')}</p></article></main>`;
    rects.set(document.querySelector('main')!, { top: 0, bottom: 9000 });
    await run(makeReader());
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it('brings the paragraph being read into view, but leaves a person who is scrolling alone', async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      document.body.innerHTML = `<article><p>one${translation('甲段。')}</p></article>`;
      const span = document.querySelector<HTMLElement>('[data-yilin="translation"]')!;
      rects.set(span, { top: 2000, bottom: 2100 });
      await run(makeReader());
      expect(scrollIntoView).toHaveBeenCalledTimes(1);

      scrollIntoView.mockClear();
      const reader = makeReader();
      reader.start();
      document.dispatchEvent(new Event('wheel'));
      await vi.waitFor(() => expect(reader.active).toBe(false), { timeout: 4000 });
      expect(scrollIntoView).not.toHaveBeenCalled();
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });
});

describe('on a phone, where system speech is cut off in the background', () => {
  const setVisibility = (value: 'visible' | 'hidden') => {
    Object.defineProperty(document, 'visibilityState', { value, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  };
  const paragraphs = (...texts: string[]) =>
    (document.body.innerHTML = `<article>${texts.map((x) => `<p>x${translation(x)}</p>`).join('')}</article>`);

  beforeEach(() => {
    spoken.length = 0;
    install(EDGE);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (document as { visibilityState?: unknown }).visibilityState;
  });

  const make = (extra: Partial<ConstructorParameters<typeof ArticleReader>[1]> = {}) =>
    new ArticleReader(document, { isTranslating: () => false, onChange: () => {}, settleMs: 5, userPauseMs: 60, ...extra });

  it('waits for the page to come back and says the cut-off sentence again, losing nothing', async () => {
    paragraphs('甲。', '乙。');
    let calls = 0;
    vi.stubGlobal('speechSynthesis', {
      getVoices: () => EDGE,
      cancel() {},
      addEventListener() {},
      speak(u: { text: string; onend?: () => void; onerror?: (e: { error: string }) => void }) {
        spoken.push(u.text);
        calls++;
        queueMicrotask(() => {
          if (calls === 1) {
            // The screen goes off while the first sentence is being spoken.
            setVisibility('hidden');
            u.onerror?.({ error: 'interrupted' });
          } else u.onend?.();
        });
      },
    });
    const reader = make();
    reader.start();
    await vi.waitFor(() => expect(spoken).toEqual(['甲。']));
    // Still waiting, not marching on and failing sentence after sentence.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(spoken).toEqual(['甲。']);
    expect(reader.active).toBe(true);

    setVisibility('visible');
    await vi.waitFor(() => expect(reader.active).toBe(false), { timeout: 3000 });
    expect(spoken).toEqual(['甲。', '甲。', '乙。']);
  });

  it('stops waiting when the reading is stopped', async () => {
    paragraphs('甲。');
    vi.stubGlobal('speechSynthesis', {
      getVoices: () => EDGE,
      cancel() {},
      addEventListener() {},
      speak(u: { onerror?: (e: { error: string }) => void }) {
        queueMicrotask(() => {
          setVisibility('hidden');
          u.onerror?.({ error: 'interrupted' });
        });
      },
    });
    const reader = make();
    reader.start();
    await new Promise((resolve) => setTimeout(resolve, 40));
    reader.stop('test');
    expect(reader.active).toBe(false);
  });

  it('does not loop on a failure while the page is in front', async () => {
    paragraphs('甲。', '乙。');
    vi.stubGlobal('speechSynthesis', {
      getVoices: () => EDGE,
      cancel() {},
      addEventListener() {},
      speak(u: { text: string; onerror?: (e: { error: string }) => void }) {
        spoken.push(u.text);
        queueMicrotask(() => u.onerror?.({ error: 'synthesis-failed' }));
      },
    });
    const reader = make();
    reader.start();
    await vi.waitFor(() => expect(reader.active).toBe(false), { timeout: 3000 });
    expect(spoken).toEqual(['甲。', '乙。']);
  });

  it('asks for the article to be translated ahead only on a touch device', async () => {
    paragraphs('甲。');
    const prepare = vi.fn();
    const desktop = make({ prepare });
    desktop.start();
    await vi.waitFor(() => expect(desktop.active).toBe(false), { timeout: 3000 });
    expect(prepare).not.toHaveBeenCalled();

    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(pointer: coarse)' }));
    const phone = make({ prepare });
    phone.start();
    await vi.waitFor(() => expect(phone.active).toBe(false), { timeout: 3000 });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect((prepare.mock.calls[0] as unknown[])[0]).toBe(document.querySelector('article'));
  });

  it('does not scroll the page on while it is in the background', async () => {
    paragraphs('甲。');
    const scrollBy = vi.fn();
    window.scrollBy = scrollBy as unknown as typeof window.scrollBy;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const r = this.tagName === 'ARTICLE' ? { top: 0, bottom: 5000 } : { top: 0, bottom: 0 };
      return { ...r, left: 0, right: 0, width: 0, height: r.bottom - r.top, x: 0, y: r.top, toJSON() {} } as DOMRect;
    });
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    const reader = make();
    reader.start();
    await vi.waitFor(() => expect(reader.active).toBe(false), { timeout: 3000 });
    expect(scrollBy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

describe('reading diagnostics', () => {
  beforeEach(() => {
    spoken.length = 0;
    install(EDGE);
    mount();
    document.getElementById('yilin-trace')?.remove();
  });
  afterEach(() => {
    localStorage.removeItem('yilinDebug');
    vi.unstubAllGlobals();
    delete (document as { visibilityState?: unknown }).visibilityState;
  });

  it('records nothing and shows nothing unless switched on', async () => {
    const reader = new ArticleReader(document, { isTranslating: () => false, onChange: () => {} });
    reader.start();
    await vi.waitFor(() => expect(reader.active).toBe(false), { timeout: 3000 });
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(document.getElementById('yilin-trace')).toBeNull();
  });

  it('keeps a trace of what happened and shows it when the page comes back to the front', async () => {
    localStorage.setItem('yilinDebug', '1');
    const reader = new ArticleReader(document, { isTranslating: () => false, onChange: () => {} });
    reader.start();
    await vi.waitFor(() => expect(reader.active).toBe(false), { timeout: 3000 });
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));

    const panel = document.getElementById('yilin-trace')!;
    expect(panel).not.toBeNull();
    const text = panel.shadowRoot!.textContent!;
    expect(text).toContain('start:');
    expect(text).toContain('utterance end');
    expect(text).toContain('finished');
    expect(text).toContain('page hidden');
  });

  it('is switched on from the settings page and names the build and why the server voice was not used', async () => {
    const reader = new ArticleReader(document, {
      isTranslating: () => false,
      onChange: () => {},
      debug: () => true,
      remoteError: () => 'UNAUTHENTICATED',
      speakRemote: async () => null,
    });
    install(CHROME);
    reader.start();
    await vi.waitFor(() => expect(reader.active).toBe(false), { timeout: 3000 });
    // Reading ended with the page in front, so the panel is already there.
    const text = document.getElementById('yilin-trace')!.shadowRoot!.textContent!;
    expect(text).toMatch(/build /);
    expect(text).toContain('server voice: none (UNAUTHENTICATED)');
  });

  it('says who stopped the reading', () => {
    localStorage.setItem('yilinDebug', '1');
    const reader = new ArticleReader(document, { isTranslating: () => false, onChange: () => {} });
    reader.start();
    reader.stop('popup button');
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(document.getElementById('yilin-trace')!.shadowRoot!.textContent).toContain('stop(popup button)');
  });
});

describe('keeping the reading alive with the screen off', () => {
  const handlers = new Map<string, (() => void) | null>();
  const mediaSession = { metadata: null as unknown, playbackState: 'none', setActionHandler: (name: string, fn: (() => void) | null) => void handlers.set(name, fn) };

  beforeEach(() => {
    spoken.length = 0;
    handlers.clear();
    mediaSession.metadata = null;
    mediaSession.playbackState = 'none';
    install(EDGE);
    Object.defineProperty(window.navigator, 'mediaSession', { value: mediaSession, configurable: true });
    vi.stubGlobal('MediaMetadata', class { constructor(readonly init: unknown) {} });
    mount();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (window.navigator as { mediaSession?: unknown }).mediaSession;
  });

  it('registers a media session while reading and lets go of it afterwards', async () => {
    const reader = new ArticleReader(document, { isTranslating: () => false, onChange: () => {} });
    reader.start();
    expect(mediaSession.playbackState).toBe('playing');
    expect(mediaSession.metadata).not.toBeNull();
    expect(handlers.get('pause')).toBeTypeOf('function');
    await vi.waitFor(() => expect(reader.active).toBe(false), { timeout: 3000 });
    expect(mediaSession.playbackState).toBe('none');
    expect(handlers.get('pause')).toBeNull();
    expect(mediaSession.metadata).toBeNull();
  });

  it('stops reading when the lock-screen pause button is pressed', () => {
    const reader = new ArticleReader(document, { isTranslating: () => false, onChange: () => {} });
    reader.start();
    expect(reader.active).toBe(true);
    handlers.get('pause')!();
    expect(reader.active).toBe(false);
    expect(mediaSession.playbackState).toBe('none');
  });

  it('plays the server voice through a media element when the browser can', async () => {
    const played: string[] = [];
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:fake', revokeObjectURL() {} }));
    install(CHROME);
    vi.stubGlobal('Audio', class {
      loop = false;
      src = '';
      onended: (() => void) | null = null;
      onpause: (() => void) | null = null;
      onerror: (() => void) | null = null;
      play() {
        if (this.src) played.push(this.src);
        if (this.src) queueMicrotask(() => this.onended?.());
        return Promise.resolve();
      }
      pause() {}
    });
    const remote = vi.fn(async () => new ArrayBuffer(8));
    const reader = new ArticleReader(document, { isTranslating: () => false, onChange: () => {}, speakRemote: remote });
    reader.start();
    await vi.waitFor(() => expect(reader.active).toBe(false), { timeout: 3000 });
    expect(played.filter((u) => u === 'blob:fake').length).toBeGreaterThan(0);
    expect(spoken).toEqual([]);
  });
});
