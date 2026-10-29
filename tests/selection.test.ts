import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSelectionLookup } from '../src/content/selection';
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/settings';
import { CATALOGS, type MessageKey } from '../src/shared/i18n';
import { MAX_LOOKUP_CONTEXT_CHARS, isSingleWord, isValidLookup, type LookupEntry } from '../src/shared/messages';
import { lookupViaPlatform } from '../src/background/platform-provider';

const zh = (key: MessageKey) => CATALOGS['zh-CN'][key];

// jsdom gives every range a zero-sized rect, and the bubble refuses to open on one.
Range.prototype.getBoundingClientRect = () => new DOMRect(10, 20, 50, 16);

function selectText(node: Node, start: number, end: number) {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  return range;
}

function mount(options: {
  entry?: LookupEntry;
  error?: string;
  settings?: Partial<Settings>;
  speak?: (text: string, lang: string) => void;
  typewriter?: boolean;
  save?: (entry: LookupEntry, context: string) => Promise<'added' | 'exists' | 'full'>;
  isSaved?: (text: string) => Promise<boolean>;
} = {}) {
  document.body.innerHTML = '<p id="p">The committee will table the motion tomorrow.</p>';
  const lookup = vi.fn(async () => {
    if (options.error) throw new Error(options.error);
    return options.entry ?? { text: 'table', translation: '搁置', source: 'engine' as const };
  });
  const api = createSelectionLookup(document, {
    // jsdom reports an English browser locale; pin the UI language so the wording is predictable.
    settings: { ...DEFAULT_SETTINGS, uiLang: 'zh-CN', ...options.settings },
    lookup,
    speak: options.speak ?? (() => {}),
    typewriter: options.typewriter ?? false,
    save: options.save,
    isSaved: options.isSaved,
  });
  const shadow = api._internals.shadow;
  const q = <T extends Element>(selector: string) => shadow.querySelector<T>(selector);
  return { api, lookup, shadow, q };
}

describe('keeping a word', () => {
  it('shows a star only when there is a word book, saves with the sentence, and fills in once saved', async () => {
    const none = mount();
    selectText(document.getElementById('p')!.firstChild!, 19, 24);
    none.api._internals.onSelection();
    none.q<HTMLButtonElement>('.pin')!.click();
    await vi.waitFor(() => expect(none.q('.translation')).not.toBeNull());
    expect(none.q('.save')).toBeNull();

    const save = vi.fn(async (_entry: LookupEntry, _context: string) => 'added' as const);
    const { api, q } = mount({ save, isSaved: async () => false });
    selectText(document.getElementById('p')!.firstChild!, 19, 24);
    api._internals.onSelection();
    q<HTMLButtonElement>('.pin')!.click();
    await vi.waitFor(() => expect(q('.save')).not.toBeNull());
    expect(q('.save')!.textContent).toBe('☆');
    q<HTMLButtonElement>('.save')!.click();
    await vi.waitFor(() => expect(q('.save')!.textContent).toBe('★'));
    expect(save.mock.calls[0]![0]).toMatchObject({ text: 'table' });
    expect(save.mock.calls[0]![1]).toContain('The committee will table the motion tomorrow.');
    expect(q('.save')!.getAttribute('title')).toBe(zh('vocab.saved'));
  });

  it('shows an already kept word as kept', async () => {
    const { api, q } = mount({ save: async () => 'exists', isSaved: async () => true });
    selectText(document.getElementById('p')!.firstChild!, 19, 24);
    api._internals.onSelection();
    q<HTMLButtonElement>('.pin')!.click();
    await vi.waitFor(() => expect(q('.save')!.textContent).toBe('★'));
  });
});

describe('what counts as a word', () => {
  it('treats one token as a word and a passage as a passage', () => {
    expect(isSingleWord('table')).toBe(true);
    expect(isSingleWord('词')).toBe(true);
    expect(isSingleWord('table.')).toBe(true);
    expect(isSingleWord('table the motion')).toBe(false);
    expect(isSingleWord('，')).toBe(false);
    expect(isSingleWord('a'.repeat(40))).toBe(false);
  });

  it('rejects malformed lookup requests', () => {
    const valid = { type: 'LOOKUP', targetLang: 'zh-CN', text: 'table', context: '' };
    expect(isValidLookup(valid)).toBe(true);
    expect(isValidLookup({ ...valid, targetLang: 'xx' })).toBe(false);
    expect(isValidLookup({ ...valid, text: '   ' })).toBe(false);
    expect(isValidLookup({ ...valid, text: 'a'.repeat(601) })).toBe(false);
    expect(isValidLookup({ ...valid, context: 'a'.repeat(601) })).toBe(false);
    expect(isValidLookup({ ...valid, type: 'TRANSLATE_BATCH' })).toBe(false);
  });
});

describe('selection lookup', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    document.querySelectorAll('#yilin-selection').forEach((n) => n.remove());
  });

  it('offers a button rather than translating as soon as text is selected', () => {
    const { api, lookup, q } = mount();
    selectText(document.getElementById('p')!.firstChild!, 4, 13);
    api._internals.onSelection();
    expect(q('.pin')!.textContent).toBe(zh('selection.pin'));
    expect(lookup).not.toHaveBeenCalled();
    expect(q('.bubble')).toBeNull();
  });

  it('sends the selection with the sentence around it when the button is pressed', async () => {
    const { api, lookup } = mount();
    selectText(document.getElementById('p')!.firstChild!, 19, 24);
    api._internals.onSelection();
    (document.querySelector('#yilin-selection')!.shadowRoot!.querySelector('.pin') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(lookup).toHaveBeenCalled());
    const [text, context] = lookup.mock.calls[0] as unknown as [string, string];
    expect(text).toBe('table');
    expect(context).toContain('The committee will');
    expect(context.length).toBeLessThanOrEqual(MAX_LOOKUP_CONTEXT_CHARS);
  });

  it('shows the dictionary entry: phonetics, senses and the meaning in context', async () => {
    const entry: LookupEntry = {
      text: 'table',
      translation: '搁置',
      phonetic: '/ˈteɪbl/',
      senses: [{ pos: '名词', meaning: '桌子' }, { pos: '动词', meaning: '把…搁置' }],
      inContext: '这里指把动议推迟处理。',
      sourceLang: 'en',
      source: 'model',
    };
    const { api, q } = mount({ entry });
    selectText(document.getElementById('p')!.firstChild!, 19, 24);
    api._internals.onSelection();
    q<HTMLButtonElement>('.pin')!.click();
    await vi.waitFor(() => expect(q('.translation')).not.toBeNull());
    expect(q('.word')!.textContent).toBe('table');
    expect(q('.phonetic')!.textContent).toBe('/ˈteɪbl/');
    expect(q('.translation')!.textContent).toBe('搁置');
    expect([...q('.senses')!.children].map((li) => li.textContent)).toEqual(['名词桌子', '动词把…搁置']);
    expect(q('.context')!.textContent).toContain('这里指把动议推迟处理。');
    // The model answered, so there is nothing to upsell.
    expect(q('.foot')).toBeNull();
  });

  it('opens the bubble when the pointer rests on the button, without a click', async () => {
    const { api, lookup, q } = mount();
    selectText(document.getElementById('p')!.firstChild!, 19, 24);
    api._internals.onSelection();
    q<HTMLButtonElement>('.pin')!.dispatchEvent(new MouseEvent('mouseenter'));
    expect(lookup).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(q('.translation')).not.toBeNull());
  });

  it('looks a word up once when a touch tap fires a fake hover before the click', async () => {
    const { api, lookup, q } = mount();
    selectText(document.getElementById('p')!.firstChild!, 19, 24);
    api._internals.onSelection();
    const pin = q<HTMLButtonElement>('.pin')!;
    pin.dispatchEvent(new MouseEvent('mouseenter'));
    pin.click();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('does not open on hover at all on a device without hover', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(hover: none)' }));
    try {
      const { api, lookup, q } = mount();
      selectText(document.getElementById('p')!.firstChild!, 19, 24);
      api._internals.onSelection();
      q<HTMLButtonElement>('.pin')!.dispatchEvent(new MouseEvent('mouseenter'));
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(lookup).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does nothing when the pointer only passes over the button', async () => {
    const { api, lookup, q } = mount();
    selectText(document.getElementById('p')!.firstChild!, 19, 24);
    api._internals.onSelection();
    const pin = q<HTMLButtonElement>('.pin')!;
    pin.dispatchEvent(new MouseEvent('mouseenter'));
    pin.dispatchEvent(new MouseEvent('mouseleave'));
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(lookup).not.toHaveBeenCalled();
  });

  it('types the entry out instead of showing it at once', async () => {
    const entry: LookupEntry = { text: 'table', translation: '搁置这项动议并稍后再议', source: 'engine' };
    const { api, q } = mount({ entry, typewriter: true });
    selectText(document.getElementById('p')!.firstChild!, 19, 24);
    api._internals.onSelection();
    q<HTMLButtonElement>('.pin')!.click();
    await vi.waitFor(() => expect(q('.translation')).not.toBeNull());
    // The part not typed yet is present but invisible, so the visible text is the first text node.
    expect((q('.translation')!.firstChild as Text).data.length).toBeLessThan(entry.translation.length);
    expect(q('.rest')).not.toBeNull();
    await vi.waitFor(() => expect(q('.translation')!.textContent).toBe(entry.translation), { timeout: 3000 });
    await vi.waitFor(() => expect(q('.rest')).toBeNull(), { timeout: 3000 });
    expect(q('.foot')!.textContent).toBe(zh('selection.vipHint'));
  });

  it('speaks the word in its own language', async () => {
    const speak = vi.fn();
    const entry: LookupEntry = { text: 'table', translation: '搁置', sourceLang: 'en', source: 'model' };
    const { api, q } = mount({ entry, speak });
    selectText(document.getElementById('p')!.firstChild!, 19, 24);
    api._internals.onSelection();
    q<HTMLButtonElement>('.pin')!.click();
    await vi.waitFor(() => expect(q('.speak')).not.toBeNull());
    q<HTMLButtonElement>('.speak')!.click();
    expect(speak).toHaveBeenCalledWith('table', 'en');
  });

  it('stays open while the user presses speak, and closes on the close button', async () => {
    const speak = vi.fn();
    const { api, q } = mount({ entry: { text: 'shipment', translation: '运输', sourceLang: 'en', source: 'model' }, speak });
    selectText(document.getElementById('p')!.firstChild!, 19, 24);
    api._internals.onSelection();
    q<HTMLButtonElement>('.pin')!.click();
    await vi.waitFor(() => expect(q('.speak')).not.toBeNull());

    // Clicking inside the bubble clears the page selection; that must not be read as "nothing selected".
    const speakButton = q<HTMLButtonElement>('.speak')!;
    speakButton.click();
    window.getSelection()!.removeAllRanges();
    speakButton.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(speak).toHaveBeenCalledTimes(1);
    expect(q('.bubble')).not.toBeNull();

    q<HTMLButtonElement>('.close')!.click();
    expect(q('.bubble')).toBeNull();
  });

  it('tells a free account why there is only a translation', async () => {
    const { api, q } = mount({ entry: { text: 'table', translation: '搁置', source: 'engine' } });
    selectText(document.getElementById('p')!.firstChild!, 19, 24);
    api._internals.onSelection();
    q<HTMLButtonElement>('.pin')!.click();
    await vi.waitFor(() => expect(q('.foot')).not.toBeNull());
    expect(q('.foot')!.textContent).toBe(zh('selection.vipHint'));
    expect(q('.senses')).toBeNull();
  });

  it('shows the known error wording and falls back for the rest', async () => {
    for (const [code, key] of [['QUOTA_EXCEEDED', 'pageError.QUOTA_EXCEEDED'], ['WEIRD', 'pageError.PROVIDER_UNAVAILABLE']] as const) {
      document.querySelectorAll('#yilin-selection').forEach((n) => n.remove());
      const { api, q } = mount({ error: code });
      selectText(document.getElementById('p')!.firstChild!, 19, 24);
      api._internals.onSelection();
      q<HTMLButtonElement>('.pin')!.click();
      await vi.waitFor(() => expect(q('.error')).not.toBeNull());
      expect(q('.error')!.textContent).toBe(zh(key));
    }
  });

  it('stays out of the way of text the user is editing', () => {
    const { api, q } = mount();
    document.body.innerHTML = '<textarea id="t">draft text</textarea><div contenteditable="true" id="c">note</div>';
    for (const id of ['c']) {
      selectText(document.getElementById(id)!.firstChild!, 0, 4);
      api._internals.onSelection();
      expect(q('.pin')).toBeNull();
    }
  });

  it('does nothing while the feature is switched off', () => {
    const { api, q } = mount({ settings: { selectionLookup: false } });
    selectText(document.getElementById('p')!.firstChild!, 19, 24);
    api._internals.onSelection();
    expect(q('.pin')).toBeNull();
  });

  it('closes on Escape and removes everything it added when disposed', () => {
    const { api, q } = mount();
    selectText(document.getElementById('p')!.firstChild!, 19, 24);
    api._internals.onSelection();
    expect(q('.pin')).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(q('.pin')).toBeNull();
    api.dispose();
    expect(document.getElementById('yilin-selection')).toBeNull();
  });
});

describe('lookup over the platform API', () => {
  const ok = (entry: Record<string, unknown>) =>
    vi.fn(async () => new Response(JSON.stringify({ ok: true, entry }), { status: 200 }));

  it('returns the model entry, marked as coming from the model', async () => {
    const fetchMock = ok({ translation: '搁置', phonetic: '/ˈteɪbl/', sourceLang: 'en' });
    const entry = await lookupViaPlatform({
      apiBase: 'https://api.example', token: 'tok', targetLang: 'zh-CN', text: 'table', context: 'a sentence',
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(entry).toMatchObject({ text: 'table', translation: '搁置', phonetic: '/ˈteɪbl/', source: 'model' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example/v1/lookup');
    expect(JSON.parse(String(init.body))).toEqual({ targetLang: 'zh-CN', text: 'table', context: 'a sentence' });
  });

  it('refuses to call the server without a token', async () => {
    const fetchMock = vi.fn();
    await expect(lookupViaPlatform({
      apiBase: 'https://api.example', token: '', targetLang: 'zh-CN', text: 'table', context: '',
      fetch: fetchMock as unknown as typeof fetch,
    })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes the server error code through, so the caller can fall back', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'PLAN_REQUIRED' }), { status: 403 }));
    await expect(lookupViaPlatform({
      apiBase: 'https://api.example', token: 'tok', targetLang: 'zh-CN', text: 'table', context: '',
      fetch: fetchMock as unknown as typeof fetch,
    })).rejects.toMatchObject({ code: 'PLAN_REQUIRED' });
  });
});
