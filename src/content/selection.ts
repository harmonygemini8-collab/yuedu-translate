/**
 * Selection lookup (doc/03 FR-15, doc/04 §4.2). Selecting text on the page puts a small button
 * next to it; pressing that button opens a bubble with the translation, and for a single word a
 * dictionary entry: phonetics with a speak button, senses, and what it means in this sentence.
 *
 * The button is deliberate rather than automatic so that copying, re-reading and dragging a
 * selection are not interrupted; resting the pointer on it for a moment opens the bubble without a
 * click, and the entry is typed out as it arrives. Everything lives in a shadow root so page CSS cannot reach it,
 * and all text is written with textContent.
 */

import { RTL_LANGUAGES, createTranslator, resolveUiLang, type MessageKey, type Translator } from '../shared/i18n';
import { MAX_LOOKUP_CHARS, MAX_LOOKUP_CONTEXT_CHARS, type LookupEntry } from '../shared/messages';
import type { Settings, TargetLang } from '../shared/settings';

const HOST_ID = 'yilin-selection';
const EDITABLE = 'input, textarea, [contenteditable=""], [contenteditable="true"]';
const BUBBLE_WIDTH = 340;

export interface SelectionDeps {
  /**
   * Asks the background for the entry; rejects with an Error whose message is an ErrorCode.
   * The target language is passed per call rather than read from the settings the caller
   * captured at startup, which would freeze lookups to whatever language was set then.
   */
  lookup(text: string, context: string, targetLang: TargetLang): Promise<LookupEntry>;
  /** Speaks the word. Defaults to the browser's own speech synthesis. */
  speak?(text: string, lang: string): void;
  /** Keeps the word in the reader's word book; resolves to whether it was added, was already there, or the book is full. */
  save?(entry: LookupEntry, context: string): Promise<'added' | 'exists' | 'full'>;
  /** Whether the word is already kept, so the star shows filled. */
  isSaved?(text: string): Promise<boolean>;
  settings: Settings;
  /** Type the entry out character by character. On by default; tests turn it off to read the text at once. */
  typewriter?: boolean;
}

/** How long the pointer must rest on the button before the bubble opens, so passing over it does nothing. */
const HOVER_DELAY_MS = 150;
const TYPE_TICK_MS = 18;
/** The whole entry is typed in about a second, however long it is. */
const TYPE_TICKS = 55;

const STYLE = `
:host { all: initial; }
.layer { --accent: #2f6f5e; --accent-wash: rgb(47 111 94 / 10%); --muted: #6b7280; --error: #b42318; position: absolute; z-index: 2147483646; font: 14px/1.6 system-ui, "Microsoft YaHei", sans-serif; color: CanvasText; }
.pin {
  display: flex; align-items: center; gap: 4px; padding: 3px 8px; cursor: pointer;
  background: var(--accent); color: #fff; border: 0; border-radius: 6px; font: inherit; font-size: 12px;
  box-shadow: 0 2px 8px rgb(0 0 0 / 30%);
}
.bubble {
  width: 340px; max-width: min(340px, calc(100vw - 24px)); max-height: 60vh; overflow-y: auto;
  padding: 14px 16px 12px; background: Canvas; color: CanvasText;
  border: 1px solid rgb(128 128 128 / 30%); border-radius: 12px; box-shadow: 0 12px 32px rgb(0 0 0 / 22%);
}
.head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.word { font-size: 19px; font-weight: 700; word-break: break-word; }
.phonetic { color: var(--muted); font-size: 13px; }
.speak, .close {
  border: 0; background: transparent; color: inherit; cursor: pointer; font: inherit; font-size: 14px;
  padding: 2px 4px; border-radius: 4px; opacity: 0.7;
}
.save { border: 0; background: transparent; color: inherit; cursor: pointer; font: inherit; font-size: 15px; padding: 2px 4px; border-radius: 4px; opacity: 0.7; }
.save:hover, .save[aria-pressed="true"] { opacity: 1; background: rgb(128 128 128 / 18%); }
.speak:hover, .close:hover { opacity: 1; background: rgb(128 128 128 / 18%); }
.close { margin-inline-start: auto; }
.senses { margin: 10px 0 0; padding: 0; list-style: none; }
.senses li { display: flex; gap: 10px; align-items: baseline; padding: 5px 0; }
.pos { flex: none; min-width: 1.8em; color: var(--accent); font-size: 12px; font-style: italic; font-weight: 600; }
.meaning { font-size: 14px; }
.context {
  margin: 12px 0 0; padding: 10px 12px; border-radius: 8px;
  background: var(--accent-wash);
}
.translation { margin: 0; font-size: 15px; }
.translation.lead { font-weight: 600; }
.context-label { display: block; margin-top: 8px; color: var(--accent); font-size: 12px; }
.context-text { font-size: 13px; line-height: 1.7; }
.rest { visibility: hidden; }
.foot { margin: 10px 0 0; color: var(--muted); font-size: 12px; }
.error { margin: 0; color: var(--error); }
.loading { margin: 0; color: var(--muted); }
`;

/** The sentence the selection sits in, so the model can explain the word as it is used here. */
function sentenceAround(range: Range, selected: string): string {
  const node = range.commonAncestorContainer;
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  const block = element?.closest('p, li, td, dd, blockquote, h1, h2, h3, h4, h5, h6, article, section, div');
  const text = block?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  if (!text || text.length <= MAX_LOOKUP_CONTEXT_CHARS) return text;
  // Keep the window around the selection rather than truncating from the start of a long block.
  const at = text.indexOf(selected.replace(/\s+/g, ' ').trim());
  const from = at < 0 ? 0 : Math.max(0, at - Math.floor(MAX_LOOKUP_CONTEXT_CHARS / 2));
  return text.slice(from, from + MAX_LOOKUP_CONTEXT_CHARS);
}

/** Error codes with their own wording; anything else falls back to "service unavailable". */
const ERROR_KEYS: readonly string[] = [
  'NETWORK', 'RATE_LIMITED', 'QUOTA_EXCEEDED', 'UNAUTHENTICATED', 'PLAN_REQUIRED', 'NOT_CONFIGURED', 'INVALID_REQUEST',
];

export function createSelectionLookup(doc: Document, deps: SelectionDeps) {
  let settings = deps.settings;
  let uiLang = resolveUiLang(settings.uiLang);
  let t: Translator = createTranslator(uiLang);
  const speak = deps.speak ?? ((text: string, lang: string) => {
    // Local speech synthesis: no network, no permission, and it covers whatever voices the system has.
    const synth = doc.defaultView?.speechSynthesis;
    if (!synth) return;
    synth.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    if (lang) utterance.lang = lang;
    synth.speak(utterance);
  });

  const host = doc.createElement('div');
  host.id = HOST_ID;
  host.setAttribute('data-yilin', 'selection');
  const shadow = host.attachShadow({ mode: 'open' });
  const style = doc.createElement('style');
  style.textContent = STYLE;
  const layer = doc.createElement('div');
  layer.className = 'layer';
  layer.hidden = true;
  shadow.append(style, layer);

  /** What the button would look up if pressed; null while nothing is selected. */
  let pending: { text: string; context: string } | null = null;
  /** Bumped on every new request so a slow answer cannot overwrite a newer one. */
  let requestId = 0;

  const el = (tag: string, className?: string, text?: string) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  let typing: ReturnType<typeof setInterval> | undefined;

  /**
   * Types the entry out in place. Each text run keeps its final layout from the start (the part not typed
   * yet is invisible, not absent), so the bubble does not grow or re-wrap while it fills in.
   */
  function typeOut(root: HTMLElement) {
    clearInterval(typing);
    const view = doc.defaultView;
    if (deps.typewriter === false || view?.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const runs: { shown: Text; rest: HTMLElement; chars: string[]; at: number }[] = [];
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const texts: Text[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n as Text;
      if (text.data.trim() && !text.parentElement?.closest('button')) texts.push(text);
    }
    for (const text of texts) {
      const chars = Array.from(text.data);
      const rest = el('span', 'rest', text.data);
      text.data = '';
      text.after(rest);
      runs.push({ shown: text, rest, chars, at: 0 });
    }
    const total = runs.reduce((n, r) => n + r.chars.length, 0);
    const step = Math.max(1, Math.ceil(total / TYPE_TICKS));
    let current = 0;
    typing = setInterval(() => {
      let budget = step;
      while (budget > 0 && current < runs.length) {
        const run = runs[current]!;
        const take = Math.min(budget, run.chars.length - run.at);
        run.at += take;
        budget -= take;
        run.shown.data = run.chars.slice(0, run.at).join('');
        run.rest.textContent = run.chars.slice(run.at).join('');
        if (run.at >= run.chars.length) {
          run.rest.remove();
          current++;
        }
      }
      if (current >= runs.length) clearInterval(typing);
    }, TYPE_TICK_MS);
  }

  function hide() {
    clearInterval(typing);
    layer.hidden = true;
    layer.replaceChildren();
    pending = null;
    requestId++;
  }

  function place(rect: DOMRect) {
    const view = doc.defaultView!;
    layer.hidden = false;
    layer.style.top = `${rect.bottom + view.scrollY + 6}px`;
    const maxLeft = view.scrollX + view.innerWidth - BUBBLE_WIDTH;
    layer.style.left = `${Math.max(8, Math.min(rect.left + view.scrollX, maxLeft))}px`;
  }

  function closeButton() {
    const close = el('button', 'close', '✕') as HTMLButtonElement;
    close.type = 'button';
    close.title = t('selection.close');
    close.setAttribute('aria-label', t('selection.close'));
    close.addEventListener('click', hide);
    return close;
  }

  function showPin(rect: DOMRect, text: string, context: string) {
    pending = { text, context };
    const pin = el('button', 'pin', t('selection.pin')) as HTMLButtonElement;
    pin.type = 'button';
    pin.title = t('selection.pinTitle');
    // Pressing the button must not clear the selection it is about to look up.
    pin.addEventListener('mousedown', (event) => event.preventDefault());
    let hover: ReturnType<typeof setTimeout> | undefined;
    // A tap makes a touch browser fire a fake mouseenter before the click; without this the word would be looked up twice.
    pin.addEventListener('click', () => {
      clearTimeout(hover);
      void run(rect, text, context);
    });
    pin.addEventListener('mouseenter', () => {
      if (doc.defaultView?.matchMedia?.('(hover: none)').matches) return;
      hover = setTimeout(() => void run(rect, text, context), HOVER_DELAY_MS);
    });
    pin.addEventListener('mouseleave', () => clearTimeout(hover));
    layer.replaceChildren(pin);
    place(rect);
  }

  async function run(rect: DOMRect, text: string, context: string) {
    const id = ++requestId;
    const bubble = el('div', 'bubble');
    bubble.append(el('p', 'loading', t('selection.loading')));
    layer.replaceChildren(bubble);
    place(rect);
    try {
      const entry = await deps.lookup(text, context, settings.targetLang);
      if (id === requestId) render(entry, context);
    } catch (err) {
      if (id === requestId) renderError(err instanceof Error ? err.message : '');
    }
  }

  function render(entry: LookupEntry, context = '') {
    const bubble = el('div', 'bubble');
    // Keep the word highlighted on the page while the bubble is open.
    bubble.addEventListener('mousedown', (event) => event.preventDefault());
    const head = el('div', 'head');
    head.append(el('span', 'word', entry.text));
    if (entry.phonetic) head.append(el('span', 'phonetic', entry.phonetic));
    const say = el('button', 'speak', '🔊') as HTMLButtonElement;
    say.type = 'button';
    say.title = t('selection.speak');
    say.setAttribute('aria-label', t('selection.speak'));
    say.addEventListener('click', () => speak(entry.text, entry.sourceLang ?? ''));
    head.append(say);
    if (deps.save && entry.text.trim()) {
      const star = el('button', 'save', '☆') as HTMLButtonElement;
      star.type = 'button';
      const mark = (kept: boolean) => {
        star.textContent = kept ? '★' : '☆';
        star.setAttribute('aria-pressed', String(kept));
        star.title = t(kept ? 'vocab.saved' : 'vocab.save');
        star.setAttribute('aria-label', star.title);
      };
      mark(false);
      void deps.isSaved?.(entry.text).then(mark).catch(() => {});
      star.addEventListener('click', () => void deps.save!(entry, context).then((result) => mark(result !== 'full')).catch(() => {}));
      head.append(star);
    }
    head.append(closeButton());
    bubble.append(head);

    if (entry.senses?.length) {
      const list = el('ul', 'senses');
      for (const sense of entry.senses) {
        const item = el('li');
        item.append(el('span', 'pos', sense.pos), el('span', 'meaning', sense.meaning));
        list.append(item);
      }
      bubble.append(list);
    }
    // The meaning here, in a tinted box of its own: what the reader came for.
    const box = el('div', 'context');
    box.append(el('p', entry.senses?.length || entry.inContext ? 'translation lead' : 'translation', entry.translation));
    if (entry.inContext) {
      box.append(el('span', 'context-label', t('selection.inContext')), el('div', 'context-text', entry.inContext));
    }
    bubble.append(box);
    // A free account gets the plain translation; say why the dictionary entry is missing.
    if (entry.source === 'engine') bubble.append(el('p', 'foot', t('selection.vipHint')));
    layer.replaceChildren(bubble);
    typeOut(bubble);
  }

  function renderError(code: string) {
    const bubble = el('div', 'bubble');
    const head = el('div', 'head');
    head.append(el('p', 'error', t((ERROR_KEYS.includes(code) ? `pageError.${code}` : 'pageError.PROVIDER_UNAVAILABLE') as MessageKey)), closeButton());
    bubble.append(head);
    layer.replaceChildren(bubble);
  }

  function onSelection() {
    if (!settings.selectionLookup) return hide();
    const selection = doc.getSelection();
    const text = selection?.toString().trim() ?? '';
    if (!selection || selection.isCollapsed || !text || text.length > MAX_LOOKUP_CHARS) return hide();
    const range = selection.getRangeAt(0);
    const node = range.commonAncestorContainer;
    const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    // Text being edited is not reading material, and our own bubble is not either.
    if (!element || element.closest(EDITABLE) || host.contains(element)) return hide();
    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) return hide();
    showPin(rect, text, sentenceAround(range, text));
  }

  // The selection is only final after the mouse is released, and the event fires before it updates.
  // Clicks on our own button and bubble are not page selections: acting on them would close the
  // bubble the moment the user pressed speak, because clicking it clears the page selection.
  const onMouseUp = (event: MouseEvent) => {
    if (event.composedPath().includes(host)) return;
    setTimeout(onSelection, 0);
  };
  const onKeyDown = (event: KeyboardEvent) => event.key === 'Escape' && hide();
  const onMouseDown = (event: MouseEvent) => {
    if (!layer.hidden && !event.composedPath().includes(host)) hide();
  };

  doc.addEventListener('mouseup', onMouseUp, true);
  doc.addEventListener('mousedown', onMouseDown, true);
  doc.addEventListener('keydown', onKeyDown, true);
  doc.documentElement.append(host);
  layer.dir = RTL_LANGUAGES.has(uiLang) ? 'rtl' : 'ltr';

  return {
    updateSettings(next: Settings) {
      settings = next;
      uiLang = resolveUiLang(settings.uiLang);
      t = createTranslator(uiLang);
      layer.dir = RTL_LANGUAGES.has(uiLang) ? 'rtl' : 'ltr';
      if (!settings.selectionLookup) hide();
    },
    dispose() {
      doc.removeEventListener('mouseup', onMouseUp, true);
      doc.removeEventListener('mousedown', onMouseDown, true);
      doc.removeEventListener('keydown', onKeyDown, true);
      host.remove();
    },
    /** Tests drive the flow through these rather than through real mouse selection. */
    _internals: { onSelection, hide, shadow, pending: () => pending },
  };
}
