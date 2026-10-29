import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/settings';
import { CAPTIONS_OFF_ATTR, SubtitleTranslator, domFeed, trackFeed, type CueFeed } from '../src/content/subtitles';

const settings = (over: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...over });

/** A player we drive by hand: `all` is what a real text track gives up front. */
function fakeFeed(all: string[], options: { live?: boolean; host?: Element } = {}) {
  const listeners = new Set<() => void>();
  let showing: string[] = [];
  let released = false;
  return {
    live: options.live,
    host: options.host,
    all: () => all,
    active: () => showing,
    onChange(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    release() {
      released = true;
    },
    show(...lines: string[]) {
      showing = lines;
      listeners.forEach((l) => l());
    },
    get released() {
      return released;
    },
  };
}

/** jsdom has no layout, so the player is given a box; without one it would look like a thumbnail. */
const RECT = { left: 100, top: 50, width: 640, height: 360, right: 740, bottom: 410, x: 100, y: 50, toJSON: () => ({}) } as DOMRect;
const video = () => document.querySelector('video') as HTMLVideoElement;
const overlayText = () => [...document.querySelectorAll('[data-yilin="subtitle"] p')].map((p) => ({ cls: p.className, text: p.textContent }));
const translationShown = () => document.querySelector('.yilin-subtitle-translation')?.textContent;
const flush = () => new Promise((r) => setTimeout(r, 0));

const live: SubtitleTranslator[] = [];
/** Every translator is stopped afterwards: a running one keeps observing the document. */
function translator(options: ConstructorParameters<typeof SubtitleTranslator>[1]) {
  const subs = new SubtitleTranslator(document, options);
  live.push(subs);
  subs.start();
  return subs;
}

const echo = (prefix: string) => async (segments: { id: string; text: string }[]) =>
  segments.map((s) => ({ id: s.id, ok: true as const, text: `${prefix}${s.text}` }));

describe('subtitle translation (FR-19)', () => {
  beforeEach(() => {
    document.body.innerHTML = '<video></video>';
    video().getBoundingClientRect = () => RECT;
  });
  afterEach(() => {
    while (live.length) live.pop()!.stop();
  });

  it('translates the whole file up front and draws both languages as cues come and go', async () => {
    const feed = fakeFeed(['Good evening.', 'This is how you spot a deepfake.']);
    const translate = vi.fn(echo('['));
    const subs = translator({ translate, settings: settings(), feeds: () => [{ video: video(), feed }] });

    await flush();
    // One request for the file, not one per line.
    expect(translate).toHaveBeenCalledTimes(1);
    expect(subs.inspect()).toMatchObject({ active: true, videos: 1, lines: 2 });

    feed.show('Good evening.');
    expect(overlayText()).toEqual([
      { cls: 'yilin-subtitle-line yilin-subtitle-source', text: 'Good evening.' },
      { cls: 'yilin-subtitle-line yilin-subtitle-translation', text: '[Good evening.' },
    ]);

    // Nothing showing: the overlay leaves the page rather than lingering over the picture.
    feed.show();
    expect(document.querySelector('[data-yilin="subtitle"]')).toBeNull();
  });

  describe('with the player\'s own caption file', () => {
    const body = JSON.stringify({
      events: [
        { tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: 'First line' }] },
        { tStartMs: 4000, dDurationMs: 2000, segs: [{ utf8: 'Second line' }] },
      ],
    });
    let clock = 0;
    const play = (seconds: number) => {
      clock = seconds;
    };
    const send = (payload: Record<string, unknown>) => {
      window.dispatchEvent(new MessageEvent('message', { data: { source: 'yilin-captions', kind: '', videoId: '', body, ...payload }, source: window }));
    };

    beforeEach(() => {
      clock = 0;
      Object.defineProperty(video(), 'currentTime', { get: () => clock, configurable: true });
    });

    it('translates every line before it is due and shows the pair at its own time, not after', async () => {
      const feed = fakeFeed([], { live: true });
      const translate = vi.fn(echo('译：'));
      translator({ translate, settings: settings(), pollMs: 10, feeds: () => [{ video: video(), feed }] });
      await flush();
      send({});
      await flush();
      // The whole file is translated while nothing is on screen yet.
      expect(translate).toHaveBeenCalledTimes(1);
      expect(translate.mock.calls[0]![0].map((s: { text: string }) => s.text)).toEqual(['First line', 'Second line']);
      expect(overlayText()).toEqual([]);

      play(1.2);
      await new Promise((r) => setTimeout(r, 30));
      expect(overlayText()).toEqual([
        { cls: 'yilin-subtitle-line yilin-subtitle-source', text: 'First line' },
        { cls: 'yilin-subtitle-line yilin-subtitle-translation', text: '译：First line' },
      ]);

      play(4.5);
      await new Promise((r) => setTimeout(r, 30));
      expect(translationShown()).toBe('译：Second line');
      // No further requests: everything was already translated.
      expect(translate).toHaveBeenCalledTimes(1);
    });

    it('translates from where the viewer is, not from the start of the file', async () => {
      play(4.5);
      const feed = fakeFeed([], { live: true });
      const translate = vi.fn(echo('译：'));
      translator({ translate, settings: settings(), feeds: () => [{ video: video(), feed }] });
      await flush();
      send({});
      await flush();
      expect(translate.mock.calls[0]![0].map((s: { text: string }) => s.text)).toEqual(['Second line', 'First line']);
    });

    it('ignores a caption file that belongs to another video', async () => {
      const feed = fakeFeed([], { live: true });
      const translate = vi.fn(echo('译：'));
      window.history.pushState({}, '', '/watch?v=current0001');
      translator({ translate, settings: settings(), feeds: () => [{ video: video(), feed }] });
      await flush();
      send({ videoId: 'someoneelse' });
      await flush();
      expect(translate).not.toHaveBeenCalled();
      window.history.pushState({}, '', '/');
    });

    it('shows nothing while an advertisement plays in the same video, and again when it is over', async () => {
      document.body.insertAdjacentHTML('beforeend', '<div class="html5-video-player"></div>');
      const player = document.querySelector('.html5-video-player')!;
      const feed = fakeFeed([], { live: true });
      translator({ translate: echo('译：'), settings: settings(), pollMs: 10, feeds: () => [{ video: video(), feed }] });
      await flush();
      send({});
      await flush();
      play(1.2);
      await new Promise((r) => setTimeout(r, 30));
      expect(translationShown()).toBe('译：First line');

      player.classList.add('ad-showing');
      await new Promise((r) => setTimeout(r, 30));
      expect(overlayText()).toEqual([]);

      player.classList.remove('ad-showing');
      await new Promise((r) => setTimeout(r, 30));
      expect(translationShown()).toBe('译：First line');
    });

    it('on the phone site, shows nothing until its captions button is on, and follows it', async () => {
      document.body.insertAdjacentHTML('beforeend', '<button class="ytmClosedCaptioningButtonButton" aria-pressed="false"></button>');
      const cc = document.querySelector('.ytmClosedCaptioningButtonButton')!;
      const feed = fakeFeed([], { live: true });
      translator({ translate: echo('译：'), settings: settings(), pollMs: 10, feeds: () => [{ video: video(), feed }] });
      await flush();
      send({});
      await flush();
      play(1.2);
      await new Promise((r) => setTimeout(r, 30));
      expect(overlayText()).toEqual([]);

      cc.setAttribute('aria-pressed', 'true');
      await new Promise((r) => setTimeout(r, 30));
      expect(translationShown()).toBe('译：First line');
    });

    it('hides the caption windows of the player by selector, so one built anew never shows', async () => {
      const feed = fakeFeed([], { live: true });
      translator({ translate: echo('译：'), settings: settings(), feeds: () => [{ video: video(), feed }] });
      await flush();
      const css = document.getElementById('yilin-subtitle-style')!.textContent!;
      expect(css).toMatch(/:root\[data-yilin-hide-captions\]\s+:is\([^)]*\.ytp-caption-window-container[^)]*\)\s*{\s*visibility:\s*hidden/);
      expect(document.documentElement.hasAttribute('data-yilin-hide-captions')).toBe(true);
      // The page itself must never carry the attribute that hides what it is on, or everything goes black.
      expect(document.documentElement.hasAttribute('data-yilin-captions-off')).toBe(false);
    });

    it('asks for the hook, and for the file again when captions were already on', async () => {
      document.body.insertAdjacentHTML('beforeend', '<button class="ytp-subtitles-button" aria-pressed="true"></button>');
      const button = document.querySelector<HTMLButtonElement>('.ytp-subtitles-button')!;
      const clicks = vi.fn();
      button.addEventListener('click', clicks);
      const injectHook = vi.fn();
      vi.useFakeTimers();
      try {
        translator({ translate: echo('译：'), settings: settings(), injectHook, feeds: () => [{ video: video(), feed: fakeFeed([], { live: true }) }] });
        expect(injectHook).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1200);
        expect(clicks).toHaveBeenCalledTimes(2); // off, then on
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('hides the caption element the player builds anew, instead of showing its own caption next to ours', async () => {
    document.body.insertAdjacentHTML('beforeend', '<div class="captions-a"></div>');
    const first = document.querySelector('.captions-a')!;
    const feeds = [fakeFeed([], { live: true, host: first })];
    const release = vi.fn();
    feeds[0]!.release = release;
    let call = 0;
    translator({ translate: echo('译：'), settings: settings(), settleMs: 20, feeds: () => (call++ === 0 ? [{ video: video(), feed: feeds[0]! }] : feeds.slice(1).map((feed) => ({ video: video(), feed }))) });
    await flush();

    // The player swaps its caption element, as YouTube does after an advertisement.
    first.remove();
    document.body.insertAdjacentHTML('beforeend', '<div class="captions-b"></div>');
    const second = fakeFeed([], { live: true, host: document.querySelector('.captions-b')! });
    feeds.push(second);
    await new Promise((r) => setTimeout(r, 30));
    expect(release).toHaveBeenCalledTimes(1);

    // The new feed is the one followed now.
    second.show('after the ad');
    await new Promise((r) => setTimeout(r, 40));
    expect(document.querySelector('[data-yilin="subtitle"]')).not.toBeNull();
  });

  it('knows whether a video has subtitles to read, before any translating starts', () => {
    const subs = new SubtitleTranslator(document, { translate: echo('译：'), settings: settings() });
    expect(subs.hasSource(video())).toBe(false);

    // A player keeps a caption element whether or not the video has captions: empty proves nothing.
    document.body.innerHTML = '<div class="player"><video></video><div class="vjs-text-track-display"></div></div>';
    expect(subs.hasSource(video())).toBe(false);

    // Once it has shown text, it is a source, and stays one while the line is between captions.
    document.querySelector('.vjs-text-track-display')!.textContent = 'A line of caption';
    expect(subs.hasSource(video())).toBe(true);
    document.querySelector('.vjs-text-track-display')!.textContent = '';
    expect(subs.hasSource(video())).toBe(true);
  });

  it('waits for an automatic caption to stop growing, then translates that sentence once', async () => {
    // YouTube rewrites the line on every word. Translating each rewrite would spend the quota on
    // fragments and flash a new translation per word.
    const feed = fakeFeed([], { live: true });
    const translate = vi.fn(echo('译：'));
    translator({ translate, settings: settings(), settleMs: 20, feeds: () => [{ video: video(), feed }] });
    await flush();

    feed.show('that were');
    feed.show('that were pretty much');
    feed.show('that were pretty much like our age');
    // The original is held back until its translation is ready, so the two appear together.
    expect(overlayText()).toEqual([]);
    expect(translate).not.toHaveBeenCalled();

    await new Promise((r) => setTimeout(r, 40));
    expect(translate).toHaveBeenCalledTimes(1);
    expect(translate.mock.calls[0]![0]).toEqual([{ id: 'sub-0', text: 'that were pretty much like our age' }]);
    expect(overlayText()).toEqual([
      { cls: 'yilin-subtitle-line yilin-subtitle-source', text: 'that were pretty much like our age' },
      { cls: 'yilin-subtitle-line yilin-subtitle-translation', text: '译：that were pretty much like our age' },
    ]);
  });

  it('keeps the last translation on screen while the next sentence is still being spoken', async () => {
    const feed = fakeFeed([], { live: true });
    translator({ translate: echo('译：'), settings: settings(), settleMs: 20, feeds: () => [{ video: video(), feed }] });
    await flush();

    feed.show('first sentence');
    await new Promise((r) => setTimeout(r, 40));
    expect(translationShown()).toBe('译：first sentence');

    // A new sentence starts: its translation is not ready, and the previous one stays rather than
    // leaving the viewer with a blank line that flickers back.
    feed.show('second');
    expect(translationShown()).toBe('译：first sentence');
    await new Promise((r) => setTimeout(r, 40));
    expect(translationShown()).toBe('译：second');
  });

  it('translates a line as it appears when the player reveals only the current one', async () => {
    const feed = fakeFeed([]);
    const translate = vi.fn(echo('译：'));
    translator({ translate, settings: settings(), feeds: () => [{ video: video(), feed }] });
    await flush();
    expect(translate).not.toHaveBeenCalled();

    feed.show('They never told us.');
    await flush();
    expect(translationShown()).toBe('译：They never told us.');

    // The same line again (a repeated name, a loop) is drawn from the cache.
    feed.show('Hello');
    await flush();
    feed.show('They never told us.');
    await flush();
    expect(translate).toHaveBeenCalledTimes(2);
  });

  it('ignores a player too small to be watched, such as a thumbnail playing under the pointer', async () => {
    const feed = fakeFeed(['A line.']);
    video().getBoundingClientRect = () => ({ ...RECT, width: 180 }) as DOMRect;
    translator({ translate: echo('x'), settings: settings(), feeds: () => [{ video: video(), feed }] });
    await flush();
    feed.show('A line.');
    // Drawing against a 180 px box once produced a column one word wide down the side of the page.
    expect(document.querySelector('[data-yilin="subtitle"]')).toBeNull();
  });

  it('shows only the translation in translation-only mode, and drops stale text when the language changes', async () => {
    const feed = fakeFeed(['One line.']);
    let mark = 'zh';
    const subs = translator({
      translate: async (segments) => segments.map((s) => ({ id: s.id, ok: true as const, text: `${mark}:${s.text}` })),
      settings: settings({ displayMode: 'translation' }),
      feeds: () => [{ video: video(), feed }],
    });

    await flush();
    feed.show('One line.');
    expect(overlayText()).toEqual([{ cls: 'yilin-subtitle-line yilin-subtitle-translation', text: 'zh:One line.' }]);

    mark = 'ja';
    subs.updateSettings(settings({ displayMode: 'translation', targetLang: 'ja' }));
    await flush();
    feed.show('One line.');
    expect(overlayText()).toEqual([{ cls: 'yilin-subtitle-line yilin-subtitle-translation', text: 'ja:One line.' }]);
  });

  it('a failed line leaves the original on screen instead of a gap', async () => {
    const feed = fakeFeed(['Untranslatable.']);
    translator({
      translate: async (segments) => segments.map((s) => ({ id: s.id, ok: false as const, error: 'NETWORK' as const })),
      settings: settings(),
      feeds: () => [{ video: video(), feed }],
    });
    await flush();
    feed.show('Untranslatable.');
    await flush();
    expect(overlayText()).toEqual([{ cls: 'yilin-subtitle-line yilin-subtitle-source', text: 'Untranslatable.' }]);
  });

  it('stacks the original above its translation instead of letting them sit side by side', async () => {
    const feed = fakeFeed(['Short one.']);
    translator({ translate: echo('短'), settings: settings(), feeds: () => [{ video: video(), feed }] });
    await flush();
    feed.show('Short one.');
    expect(document.querySelectorAll('[data-yilin="subtitle"] p')).toHaveLength(2);
    const css = document.getElementById('yilin-subtitle-style')!.textContent!;
    expect(css).toMatch(/\.yilin-subtitle-line\s*{[^}]*display:\s*block/);
    expect(css).toMatch(/\.yilin-subtitle-line\s*{[^}]*margin:\s*3px auto 0/);
  });

  it('paints the original on the same background as the translation', async () => {
    const feed = fakeFeed(['A line.']);
    translator({ translate: echo('一行'), settings: settings({ subtitleBackground: '#1f8a70' }), feeds: () => [{ video: video(), feed }] });
    await flush();
    expect(document.getElementById('yilin-subtitle-colour')!.textContent).toMatch(
      /\.yilin-subtitle-source,\s*\.yilin-subtitle-translation\s*{[^}]*background: #1f8a70/,
    );
  });

  it('paints the translation in the chosen colours and repaints when they change', async () => {
    const feed = fakeFeed(['A line.']);
    const subs = translator({
      translate: echo('一行'),
      settings: settings({ subtitleColor: '#ffffff', subtitleBackground: '#1f8a70' }),
      feeds: () => [{ video: video(), feed }],
    });
    await flush();
    const colours = () => document.getElementById('yilin-subtitle-colour')!.textContent!;
    expect(colours()).toContain('background: #1f8a70');
    expect(colours()).toContain('color: #ffffff');

    subs.updateSettings(settings({ subtitleColor: '#101010', subtitleBackground: '#ffd400' }));
    expect(colours()).toContain('background: #ffd400');
    expect(colours()).toContain('color: #101010');
    subs.stop();
    expect(document.getElementById('yilin-subtitle-colour')).toBeNull();
  });

  it('moves the whole block when dragged, and remembers where it was put', async () => {
    const feed = fakeFeed(['Drag me.']);
    const saved: { x: number; y: number }[] = [];
    const subs = translator({
      translate: echo('拖我'),
      settings: settings(),
      feeds: () => [{ video: video(), feed }],
      offset: { x: 10, y: -20 },
      onOffsetChange: (offset) => saved.push(offset),
    });
    await flush();
    feed.show('Drag me.');
    const overlay = document.querySelector('[data-yilin="subtitle"]') as HTMLElement;
    // Starts at the saved offset, not at the default spot.
    expect(overlay.style.left).toBe('110px');
    expect(overlay.style.top).toBe(`${50 + 360 * 0.74 - 20}px`);

    const press = (type: string, x: number, y: number) =>
      overlay.dispatchEvent(Object.assign(new Event(type, { bubbles: true, cancelable: true }), { pointerId: 1, clientX: x, clientY: y }));
    press('pointerdown', 200, 200);
    press('pointermove', 230, 180);
    expect(overlay.style.left).toBe('140px');
    expect(overlay.style.top).toBe(`${50 + 360 * 0.74 - 40}px`);
    press('pointerup', 230, 180);
    expect(saved).toEqual([{ x: 40, y: -40 }]);

    subs.resetPosition();
    expect(overlay.style.left).toBe('100px');
    expect(saved.at(-1)).toEqual({ x: 0, y: 0 });
  });

  it('stopping removes the overlay, the style and the hold on the player', async () => {
    const feed = fakeFeed(['A line.']);
    const subs = translator({ translate: echo('x'), settings: settings(), feeds: () => [{ video: video(), feed }] });
    await flush();
    feed.show('A line.');
    expect(document.getElementById('yilin-subtitle-style')).not.toBeNull();

    subs.stop();
    expect(document.querySelector('[data-yilin="subtitle"]')).toBeNull();
    expect(document.getElementById('yilin-subtitle-style')).toBeNull();
    expect(feed.released).toBe(true);
    expect(subs.inspect().videos).toBe(0);
  });
});

describe('reading a player', () => {
  it('loads a text track without letting the browser draw it, and restores it afterwards', () => {
    const track = {
      mode: 'showing',
      kind: 'subtitles',
      cues: [{ text: 'First line' }, { text: '  Second   line\n' }],
      activeCues: [{ text: 'First line' }],
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as TextTrack;

    const feed = trackFeed(track);
    expect(track.mode).toBe('hidden');
    // Line breaks inside a cue are joined: the translator gets one sentence, not two fragments.
    expect(feed.all()).toEqual(['First line', 'Second line']);
    expect(feed.active()).toEqual(['First line']);
    feed.release();
    expect(track.mode).toBe('showing');
  });

  it('reads captions a player draws itself, hides its own line, and reacts when it changes', async () => {
    document.body.innerHTML = '<div class="player"><div class="vjs-text-track-display"><div>Hello there</div></div></div>';
    const host = document.querySelector('.vjs-text-track-display')!;
    const feed = domFeed(host);
    const seen: string[][] = [];
    const off = feed.onChange(() => seen.push(feed.active()));
    expect(feed.active()).toEqual(['Hello there']);
    // The player's own caption is hidden, or the viewer sees the original twice.
    expect(host.hasAttribute(CAPTIONS_OFF_ATTR)).toBe(true);
    // Automatic captions rewrite themselves, so this source is marked as one to let settle.
    expect(feed.live).toBe(true);

    host.textContent = 'A second line';
    await new Promise((r) => setTimeout(r, 0));
    expect(seen.at(-1)).toEqual(['A second line']);
    off();
    feed.release();
    expect(host.hasAttribute(CAPTIONS_OFF_ATTR)).toBe(false);
  });

  it('keeps a space between caption lines that the player puts in separate elements', () => {
    document.body.innerHTML =
      '<div class="player"><div class="ytp-caption-window-container"><span>together several very different</span><span>capabilities,</span></div></div>';
    const feed = domFeed(document.querySelector('.ytp-caption-window-container')!);
    expect(feed.active()).toEqual(['together several very different capabilities,']);
    feed.release();
  });
});
