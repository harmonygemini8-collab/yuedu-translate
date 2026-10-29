import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TranslationController, type Translate, type VisibilityFactory } from '../src/content/controller';
import type { SegmentResult } from '../src/shared/messages';
import { DEFAULT_SETTINGS } from '../src/shared/settings';
import { saveTerm } from '../src/shared/glossary';

const translations = () => [...document.querySelectorAll('[data-yilin="translation"]')].map((n) => n.textContent);
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean, timeout = 1000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error('Timed out');
    await tick();
  }
}

const echo: Translate = async (segments) => segments.map((s) => ({ id: s.id, ok: true, text: `ZH:${s.text}` }));

function createController(translate: Translate = echo, visibility?: VisibilityFactory) {
  return new TranslationController(document, {
    translate,
    settings: DEFAULT_SETTINGS,
    visibility,
    flushDelayMs: 0,
    rescanDelayMs: 0,
  });
}

/** Manual visibility: nothing is "on screen" until the test says so. */
function manualVisibility() {
  const observed = new Set<Element>();
  let callback: (el: Element) => void = () => {};
  const factory: VisibilityFactory = (onVisible) => {
    callback = onVisible;
    return { observe: (el) => observed.add(el), unobserve: (el) => observed.delete(el), disconnect: () => observed.clear() };
  };
  return { factory, observed, show: (el: Element) => callback(el) };
}

describe('TranslationController', () => {
  let controller: TranslationController;

  beforeEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '<h1>Title</h1><p>First <a href="#x">link</a> paragraph</p><p>Second paragraph</p>';
  });

  afterEach(() => controller?.restore());

  it('renders translations after each original paragraph and keeps links working', async () => {
    controller = createController();
    controller.start();
    await until(() => controller.getState().translated === 3);

    expect(translations()).toEqual(['ZH:Title', 'ZH:First link paragraph', 'ZH:Second paragraph']);
    const p = document.querySelectorAll('p')[0]!;
    expect(p.firstElementChild?.tagName).toBe('A');
    expect(p.lastElementChild?.getAttribute('data-yilin')).toBe('translation');
    expect(controller.getState().status).toBe('done');
  });

  it('restores the page to its original markup', async () => {
    const original = document.body.innerHTML;
    controller = createController();
    controller.start();
    await until(() => controller.getState().translated === 3);

    controller.restore();
    expect(document.body.innerHTML).toBe(original);
    expect(document.getElementById('yilin-translate-style')).toBeNull();
    expect(controller.getState().status).toBe('idle');
  });

  it('writes translations as text, never as HTML', async () => {
    controller = createController(async (segments) =>
      segments.map((s) => ({ id: s.id, ok: true, text: '<img src=x onerror=alert(1)>' })),
    );
    controller.start();
    await until(() => controller.getState().translated === 3);
    expect(document.querySelector('[data-yilin="translation"] img')).toBeNull();
    expect(translations()[0]).toBe('<img src=x onerror=alert(1)>');
  });

  it('drops results that arrive after stop', async () => {
    let release!: (r: SegmentResult[]) => void;
    const pending = vi.fn<Translate>(() => new Promise((r) => (release = r)));
    controller = createController(pending);
    controller.start();
    await until(() => pending.mock.calls.length === 1);

    controller.stop();
    const sent = pending.mock.calls[0]![0];
    release(sent.map((s) => ({ id: s.id, ok: true, text: 'late' })));
    await tick(20);

    expect(translations()).toEqual([]);
    expect(controller.getState().status).toBe('stopped');
  });

  it('keeps finished translations when stopped and resumes without re-translating them', async () => {
    const translate = vi.fn<Translate>(echo);
    controller = createController(translate);
    controller.start();
    await until(() => controller.getState().translated === 3);
    controller.stop();
    expect(translations()).toHaveLength(3);

    controller.start();
    await tick(20);
    expect(translate).toHaveBeenCalledTimes(1);
  });

  it('only translates paragraphs that become visible', async () => {
    const vis = manualVisibility();
    const translate = vi.fn<Translate>(echo);
    controller = createController(translate, vis.factory);
    controller.start();
    expect(vis.observed.size).toBe(3);
    await tick(20);
    expect(translate).not.toHaveBeenCalled();

    vis.show(document.querySelector('h1')!);
    await until(() => controller.getState().translated === 1);
    expect(translate.mock.calls[0]![0].map((s) => s.text)).toEqual(['Title']);
  });

  it('translates what is on screen even when the visibility observer never reports it', async () => {
    // Seen on a real article: most paragraphs were registered but never queued, because an
    // IntersectionObserver never reports an element that had no size when it was observed.
    const vis = manualVisibility();
    const translate = vi.fn<Translate>(echo);
    controller = new TranslationController(document, {
      translate, settings: DEFAULT_SETTINGS, visibility: vis.factory, flushDelayMs: 0, rescanDelayMs: 0, sweepDelayMs: 0,
    });
    const rect = (top: number) => () => ({ top, bottom: top + 20, height: 20, left: 0, right: 100, width: 100, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
    const [near, farBelow] = [...document.querySelectorAll('p')] as HTMLElement[];
    document.querySelector('h1')!.getBoundingClientRect = rect(50);
    near!.getBoundingClientRect = rect(100);
    farBelow!.getBoundingClientRect = rect(99_999);

    controller.start();
    await until(() => controller.getState().translated === 2);
    expect(vis.observed.size).toBe(1); // the far paragraph is still only observed, not translated
    expect(translations()).toEqual(['ZH:Title', 'ZH:First link paragraph']);

    // Scrolling it into reach queues it without any help from the observer.
    farBelow!.getBoundingClientRect = rect(200);
    window.dispatchEvent(new Event('scroll'));
    await until(() => controller.getState().translated === 3);
    expect(translations()).toEqual(['ZH:Title', 'ZH:First link paragraph', 'ZH:Second paragraph']);
  });

  it('translates ahead inside one container on request, beyond what is near the screen', async () => {
    // Reading aloud on a phone: with the screen off nothing scrolls, so nothing below would ever translate.
    document.body.innerHTML = '<article id="a"><p>One</p><p>Two</p></article><article id="b"><p>Other</p></article>';
    const vis = manualVisibility();
    const translate = vi.fn<Translate>(echo);
    controller = new TranslationController(document, {
      translate, settings: DEFAULT_SETTINGS, visibility: vis.factory, flushDelayMs: 0, rescanDelayMs: 0, sweepDelayMs: 100_000,
    });
    const far = () => ({ top: 99_999, bottom: 100_019, height: 20, left: 0, right: 100, width: 100, x: 0, y: 99_999, toJSON: () => ({}) }) as DOMRect;
    document.querySelectorAll('p').forEach((p) => { (p as HTMLElement).getBoundingClientRect = far; });
    controller.start();
    await tick(20);
    expect(translate).not.toHaveBeenCalled();

    controller.translateWithin(document.getElementById('a')!);
    await until(() => controller.getState().translated === 2);
    expect(translations()).toEqual(['ZH:One', 'ZH:Two']);
    // The other article was not asked for, so it is still waiting.
    expect(document.querySelector('#b [data-yilin="translation"]')).toBeNull();
  });

  it('stops translating ahead once the budget is spent', async () => {
    document.body.innerHTML = '<article><p>aaaaaaaaaa</p><p>bbbbbbbbbb</p><p>cccccccccc</p></article>';
    const vis = manualVisibility();
    controller = new TranslationController(document, {
      translate: echo, settings: DEFAULT_SETTINGS, visibility: vis.factory, flushDelayMs: 0, rescanDelayMs: 0, sweepDelayMs: 100_000,
    });
    controller.start();
    controller.translateWithin(document.querySelector('article')!, 15);
    await until(() => controller.getState().translated === 2);
    await tick(20);
    // 10 chars used 10 of the 15; the second still starts within budget, the third does not.
    expect(controller.getState().translated).toBe(2);
  });

  it('puts the translation back when the page re-renders the paragraph and wipes it', async () => {
    // A news site rebuilt its paragraphs while the reader scrolled: the elements survived with
    // their ids, our translations inside them did not, and the segments stayed marked as done.
    const translate = vi.fn<Translate>(echo);
    controller = createController(translate);
    controller.start();
    await until(() => controller.getState().translated === 3);
    expect(translate).toHaveBeenCalledTimes(1);

    const p = document.querySelectorAll('p')[0]!;
    p.querySelector('[data-yilin="translation"]')!.remove();
    // Any later page change triggers the rescan that notices it.
    document.body.append(document.createElement('div'));

    await until(() => !!p.querySelector('[data-yilin="translation"]'));
    expect(p.querySelector('[data-yilin="translation"]')!.textContent).toBe('ZH:First link paragraph');
    expect(translate).toHaveBeenCalledTimes(1); // restored from memory, not translated again
  });

  it('removes a stale compact translation when reflow moves its text host, instead of leaving it orphaned', async () => {
    // A dynamic "show more" component (acquire.com) starts with one short text-bearing child, so
    // the compact translation is appended to that inner child (textHost descends to it); once the
    // text grows and a sibling toggle appears, textHost no longer descends past the outer element,
    // and the old translation — appended under the old, deeper host — must still be found and
    // removed, not left behind alongside the new one.
    document.body.innerHTML = '<div id="host"><span class="inner">Hi</span></div>';
    controller = createController();
    controller.start();
    await until(() => controller.getState().translated === 1);
    expect(translations()).toEqual(['ZH:Hi']);

    const host = document.getElementById('host')!;
    host.innerHTML =
      '<span class="inner">This changed to a long sentence with punctuation, well past forty characters.</span><span class="toggle">more</span>';
    await until(() => controller.getState().translated === 1 && translations()[0] !== 'ZH:Hi');
    // A second rescan can still be in flight right after the first one settles; let it finish too.
    await until(() => translations().length > 0, 300).catch(() => {});
    await tick(20);

    // Exactly one translation: the stale compact one (appended under the old, deeper host) must be
    // gone, not left behind next to the new block-level one.
    expect(translations()).toHaveLength(1);
    expect(translations()).toEqual(['ZH:This changed to a long sentence with punctuation, well past forty characters.more']);
  });

  it('retries a rate-limited page instead of marking every paragraph, then reports it once', async () => {
    // The free Google endpoint refuses whole batches on a long article; red text under all 92
    // paragraphs told the reader nothing about what to do.
    let attempts = 0;
    const refuse: Translate = async (segments) => {
      attempts++;
      return segments.map((s) => ({ id: s.id, ok: false as const, error: 'RATE_LIMITED' as const }));
    };
    controller = new TranslationController(document, {
      translate: refuse, settings: DEFAULT_SETTINGS, flushDelayMs: 0, rescanDelayMs: 0, sweepDelayMs: 0, backoffMs: [5, 5],
    });
    controller.start();

    // While backing off the page stays clean: no error under any paragraph.
    await until(() => attempts === 2);
    expect(translations()).toEqual([]);
    expect(controller.getState().failed).toBe(0);

    // Once retrying stops helping, the popup is told once rather than the page being covered.
    await until(() => controller.getState().blocked === 'RATE_LIMITED');
    expect(attempts).toBe(3);
    expect(translations()).toEqual([]);
  });

  it('shows a retry button for failed paragraphs and retries on click', async () => {
    let fail = true;
    controller = createController(async (segments) =>
      segments.map((s) => (fail && s.text === 'Second paragraph' ? { id: s.id, ok: false, error: 'NETWORK' } : { id: s.id, ok: true, text: `ZH:${s.text}` })),
    );
    controller.start();
    await until(() => controller.getState().failed === 1);

    fail = false;
    document.querySelector<HTMLButtonElement>('[data-yilin-retry]')!.click();
    await until(() => controller.getState().translated === 3);
    expect(controller.getState().failed).toBe(0);
  });

  it('treats a rejected request as a network failure', async () => {
    controller = createController(async () => {
      throw new Error('offline');
    });
    controller.start();
    await until(() => controller.getState().failed === 3);
    expect(document.querySelectorAll('[data-yilin-retry]')).toHaveLength(3);
  });

  it('translates content added after start', async () => {
    controller = createController();
    controller.start();
    await until(() => controller.getState().translated === 3);

    const p = document.createElement('p');
    p.textContent = 'Loaded later';
    document.body.append(p);
    await until(() => controller.getState().translated === 4);
    expect(p.querySelector('[data-yilin="translation"]')?.textContent).toBe('ZH:Loaded later');
  });

  it('discards a translation when the paragraph text changed meanwhile and translates the new text', async () => {
    let release!: (r: SegmentResult[]) => void;
    let calls = 0;
    controller = createController((segments) => {
      calls++;
      if (calls === 1) return new Promise((r) => (release = r));
      return echo(segments, 'zh-CN');
    });
    document.body.innerHTML = '<p>Old text</p>';
    controller.start();
    await until(() => calls === 1);

    const p = document.querySelector('p')!;
    p.firstChild!.textContent = 'New text';
    release([{ id: p.getAttribute('data-yilin-id')!, ok: true, text: 'ZH:Old text' }]);
    await until(() => controller.getState().translated === 1);
    expect(translations()).toEqual(['ZH:New text']);
  });

  it('does not loop on its own DOM changes', async () => {
    const translate = vi.fn<Translate>(echo);
    controller = createController(translate);
    controller.start();
    await until(() => controller.getState().translated === 3);
    await tick(50);
    expect(translate).toHaveBeenCalledTimes(1);
  });

  it('re-translates the page when the engine changes', async () => {
    let prefix = 'GOOGLE';
    controller = createController(async (segments) => segments.map((s) => ({ id: s.id, ok: true, text: `${prefix}:${s.text}` })));
    controller.start();
    await until(() => controller.getState().translated === 3);
    expect(translations()[0]).toBe('GOOGLE:Title');

    prefix = 'MICROSOFT';
    controller.updateSettings({ ...DEFAULT_SETTINGS, engine: 'microsoft' });
    await until(() => translations()[0] === 'MICROSOFT:Title');
    expect(translations()).toEqual(['MICROSOFT:Title', 'MICROSOFT:First link paragraph', 'MICROSOFT:Second paragraph']);
  });

  it('re-translates with the new scope, and whole-page mode also picks up interface text', async () => {
    document.body.insertAdjacentHTML('afterbegin', '<nav><a href="/a">Docs</a><a href="/b">Pricing</a></nav>');
    const sent: string[] = [];
    controller = createController(async (segments) => {
      sent.push(...segments.map((s) => s.text));
      return segments.map((s) => ({ id: s.id, ok: true, text: `T:${s.text}` }));
    });
    // Starts in main-text mode on purpose: `page` is the default since 0.3.4, and this test is
    // about the switch between the two.
    controller.updateSettings({ ...DEFAULT_SETTINGS, scope: 'article' });
    controller.start();
    await until(() => controller.getState().translated === 3);
    expect(sent).not.toContain('Docs');

    controller.updateSettings({ ...DEFAULT_SETTINGS, scope: 'page' });
    await until(() => translations().includes('T:Docs'));
    expect(translations()).toEqual(expect.arrayContaining(['T:Docs', 'T:Pricing', 'T:Title']));
    expect(document.querySelector('nav [data-yilin="translation"]')!.hasAttribute('data-compact')).toBe(true);
  });

  it('uses the reader\'s own glossary term, surviving a round trip through the engine untouched', async () => {
    const data: Record<string, unknown> = {};
    vi.stubGlobal('chrome', {
      storage: { local: {
        get: vi.fn(async (key: string) => ({ [key]: data[key] })),
        set: vi.fn(async (items: Record<string, unknown>) => void Object.assign(data, items)),
        remove: vi.fn(async (key: string) => void delete data[key]),
      } },
    });
    await saveTerm({ term: 'Tokenizer', translation: '分词器', lang: 'zh-CN' });
    document.body.innerHTML = '<p>Please run Tokenizer now.</p>';
    // Echoes the protected text back unchanged, so the only way "分词器" can appear is restoreTerms
    // putting the glossary's fixed translation back where the [[Tn]] placeholder stood.
    controller = createController(async (segments) => segments.map((s) => ({ id: s.id, ok: true, text: s.text })));
    controller.start();
    await until(() => controller.getState().translated === 1);
    expect(translations()[0]).toContain('分词器');
    vi.unstubAllGlobals();
  });

  it('keeps translations when only the style changes', async () => {
    const translate = vi.fn<Translate>(echo);
    controller = createController(translate);
    controller.start();
    await until(() => controller.getState().translated === 3);
    controller.updateSettings({ ...DEFAULT_SETTINGS, fontScale: 1.2 });
    await tick(30);
    expect(translate).toHaveBeenCalledTimes(1);
  });
});
