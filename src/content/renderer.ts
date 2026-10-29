import { RTL_LANGUAGES } from '../shared/i18n';
import type { DisplayMode, Settings } from '../shared/settings';
import { LINE_ATTR, MATH_TOKEN, SEGMENT_ATTR, YILIN_ATTR, insertionPoint } from './extractor';

export const RETRY_ATTR = 'data-yilin-retry';
/** Marks a paragraph whose translation is on screen; "translation only" collapses the original text of these. */
const HOST_ATTR = 'data-yilin-host';
const MODE_ATTR = 'data-yilin-mode';
const STYLE_ID = 'yilin-translate-style';

/** `lang` is the language of the text shown: the target language for translations, the UI language for status text. */
export type RenderState =
  | { kind: 'loading'; label: string; lang: string }
  | { kind: 'done'; text: string; lang: string; /** The formulas the text's `[[n]]` placeholders stand for. */ math?: Element[] }
  | { kind: 'error'; message: string; retryLabel: string; lang: string };

const hasText = (node: Node) => (node.textContent ?? '').trim() !== '';

/**
 * The innermost element holding all of `el`'s text, e.g. the <span> in `<a><svg/><span>Home</span></a>`.
 * Compact translations go there, inline after the text, instead of becoming an extra item in a
 * flex row (where browsers squeeze them to one character per line).
 */
function textHost(el: Element): Element {
  let host = el;
  for (;;) {
    if ([...host.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && hasText(n))) return host;
    const withText = [...host.children].filter((c) => !c.hasAttribute(YILIN_ATTR) && hasText(c));
    if (withText.length !== 1) return host;
    host = withText[0]!;
  }
}

const ownTranslation = (parent: Element) =>
  ([...parent.children].find((c) => c.getAttribute(YILIN_ATTR) === 'translation') as HTMLElement | undefined) ?? null;

/**
 * Searches `el`'s own subtree for the translation it previously rendered, without relying on
 * `textHost(el)` landing on the same element it did at creation time. A paragraph whose content
 * reflows — a "show more" toggle appears once the text grows past one line — can shift where
 * `textHost` resolves to, and the old translation, appended under the old host, is then missed and
 * left behind while a new one is created elsewhere (seen on a listing site's dynamic text).
 * Stops at a nested element that is its own segment (`SEGMENT_ATTR`): its translation is its own.
 */
function findOwnTranslation(el: Element): HTMLElement | null {
  const direct = ownTranslation(el);
  if (direct) return direct;
  for (const child of el.children) {
    if (child.hasAttribute(YILIN_ATTR) || child.hasAttribute(SEGMENT_ATTR)) continue;
    const found = findOwnTranslation(child);
    if (found) return found;
  }
  return null;
}

/** Find (or create) the translation node that belongs to `el`. */
function translationNode(el: Element, create: boolean, compact = false): HTMLElement | null {
  const existing = findOwnTranslation(el);
  if (existing || !create) return existing;
  const node = el.ownerDocument.createElement('span');
  node.setAttribute(YILIN_ATTR, 'translation');
  node.className = 'yilin-translation';
  if (compact) textHost(el).append(node);
  else {
    const before = insertionPoint(el);
    if (before) before.parentNode!.insertBefore(node, before);
    else el.append(node);
  }
  return node;
}

/** Whether our translation node is still attached to this paragraph (pages re-render and wipe it). */
export const hasTranslation = (el: Element) => translationNode(el, false) !== null;

/** `compact`: interface text in whole-page mode (menu item, button, label), shown inline after the text. */
/** Text, with each `[[n]]` replaced by a copy of the page's own formula; formulas the translation lost go at the end. */
function writeWithMath(node: HTMLElement, text: string, math: Element[] = []): void {
  if (math.length === 0) {
    node.textContent = text;
    return;
  }
  const used = new Set<number>();
  const copy = (formula: Element) => {
    const clone = formula.cloneNode(true) as Element;
    clone.removeAttribute('id');
    clone.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
    return clone;
  };
  let last = 0;
  for (const match of text.matchAll(MATH_TOKEN)) {
    node.append(text.slice(last, match.index));
    last = match.index + match[0].length;
    const n = Number(match[1] ?? match[2]);
    if (n >= 1 && n <= math.length && !used.has(n)) {
      used.add(n);
      node.append(copy(math[n - 1]!));
    }
  }
  node.append(text.slice(last));
  math.forEach((formula, i) => {
    if (!used.has(i + 1)) node.append(' ', copy(formula));
  });
}

export function renderTranslation(el: Element, state: RenderState, segmentId: string, compact = false): void {
  const node = translationNode(el, true, compact)!;
  // Translation-only mode shrinks the original to nothing, so the size the translation should take over
  // is read now, from the paragraph as the page styles it.
  if (!node.style.getPropertyValue('--yilin-fs')) {
    el.removeAttribute(HOST_ATTR);
    const computed = el.ownerDocument.defaultView?.getComputedStyle(el);
    if (computed?.fontSize && computed.fontSize !== '0px') {
      node.style.setProperty('--yilin-fs', computed.fontSize);
      node.style.setProperty('--yilin-lh', computed.lineHeight || 'normal');
      // Margins written in em would shrink with the font, so the paragraph's spacing is carried over in pixels.
      node.style.setProperty('--yilin-mt', computed.marginTop || '0px');
      node.style.setProperty('--yilin-mb', computed.marginBottom || '0px');
    }
  }
  if (state.kind === 'done') el.setAttribute(HOST_ATTR, 'done');
  else el.removeAttribute(HOST_ATTR);
  node.dataset.state = state.kind;
  if (compact) node.dataset.compact = '';
  else delete node.dataset.compact;
  node.lang = state.lang;
  // Arabic reads right-to-left even inside a left-to-right page (and vice versa).
  node.dir = RTL_LANGUAGES.has(state.lang) ? 'rtl' : 'ltr';
  node.replaceChildren();
  if (state.kind === 'loading') {
    // A full "translating…" note would widen every menu item; an ellipsis is enough inline.
    node.textContent = compact ? '…' : state.label;
  } else if (state.kind === 'done') {
    // Translation output is untrusted: only ever written as text, never parsed as HTML.
    writeWithMath(node, state.text, state.math);
  } else {
    const retry = el.ownerDocument.createElement('button');
    retry.type = 'button';
    retry.setAttribute(RETRY_ATTR, segmentId);
    retry.textContent = state.retryLabel;
    node.append(`${state.message} `, retry);
  }
}

export function removeTranslation(el: Element): void {
  translationNode(el, false)?.remove();
  el.removeAttribute(HOST_ATTR);
}

export function removeAllTranslations(doc: Document): void {
  doc.querySelectorAll(`[${YILIN_ATTR}="translation"]`).forEach((n) => n.remove());
  doc.querySelectorAll(`[${HOST_ATTR}]`).forEach((n) => n.removeAttribute(HOST_ATTR));
  doc.documentElement.removeAttribute(MODE_ATTR);
  // Unwrap the paragraphs we wrapped, leaving the page exactly as it was found.
  doc.querySelectorAll(`[${LINE_ATTR}]`).forEach((n) => n.replaceWith(...n.childNodes));
  doc.getElementById(STYLE_ID)?.remove();
}

export function buildStyle(settings: Settings): string {
  // Values are sanitized in sanitizeSettings; color is a strict #rrggbb or empty.
  // By default the translation looks exactly like its original paragraph: it inherits
  // font family, size, weight, style, colour and line height from the element it sits in.
  const color = settings.color ? `color: ${settings.color} !important;` : 'color: inherit !important;';
  const size = settings.fontScale === 1 ? 'font-size: inherit !important;' : `font-size: ${settings.fontScale}em !important;`;
  // Logical properties put the marker on the reading-start side: left for LTR, right for Arabic.
  const border = settings.showBorder
    ? 'border: 0 !important; border-inline-start: 2px solid currentColor !important; padding-inline-start: 0.6em !important;'
    : 'border: 0 !important; padding-inline-start: 0 !important;';
  return `
span.yilin-translation[${YILIN_ATTR}="translation"] {
  display: block !important;
  margin: ${settings.gap}px 0 0 !important;
  font: inherit !important;
  ${size}
  letter-spacing: inherit !important;
  text-transform: none !important;
  text-align: inherit !important;
  white-space: normal !important;
  opacity: 1 !important;
  ${color}
  ${border}
}
/* A translation whose direction differs from the page (Arabic on an English page, or the reverse)
   aligns to its own reading start, so the text stays next to its marker line even when the page
   sets an explicit left/right alignment. */
:where([dir="ltr"], :root:not([dir="rtl"])) span.yilin-translation[${YILIN_ATTR}="translation"][dir="rtl"],
[dir="rtl"] span.yilin-translation[${YILIN_ATTR}="translation"][dir="ltr"] {
  text-align: start !important;
}
/* Whole-page mode: menus, buttons and labels get the translation on the same line ("Home 首页"),
   never wrapped character by character, so rows keep their height and alignment. */
span.yilin-translation[${YILIN_ATTR}="translation"][data-compact] {
  display: inline !important;
  margin: 0 !important;
  margin-inline-start: 0.4em !important;
  font-size: 0.9em !important;
  font-weight: normal !important;
  line-height: inherit !important;
  white-space: nowrap !important;
  flex-shrink: 0 !important;
  border: 0 !important;
  padding: 0 !important;
}
span.yilin-translation[${YILIN_ATTR}="translation"][data-state="loading"],
span.yilin-translation[${YILIN_ATTR}="translation"][data-state="error"] {
  font-size: 0.8em !important;
  opacity: 0.6;
}
span.yilin-translation[${YILIN_ATTR}="translation"] button[${RETRY_ATTR}] {
  all: revert;
  font-size: inherit;
  cursor: pointer;
}
/* Translation only: a paragraph with its translation on screen gives up its own text (font size 0 keeps
   its images and layout) and the translation takes over its size. Loading and failed paragraphs keep
   their original, so nothing blanks out while waiting. */
html[${MODE_ATTR}="translation"] [${HOST_ATTR}="done"] {
  font-size: 0 !important;
  line-height: 0 !important;
  letter-spacing: 0 !important;
}
html[${MODE_ATTR}="translation"] [${HOST_ATTR}="done"] span.yilin-translation[${YILIN_ATTR}="translation"] {
  font-size: calc(var(--yilin-fs, 1rem) * ${settings.fontScale}) !important;
  line-height: var(--yilin-lh, normal) !important;
  letter-spacing: normal !important;
  margin: var(--yilin-mt, 0px) 0 var(--yilin-mb, 0px) !important;
  padding: 0 !important;
  border: 0 !important;
}
html[${MODE_ATTR}="translation"] [${HOST_ATTR}="done"] span.yilin-translation[${YILIN_ATTR}="translation"][data-compact] {
  margin: 0 !important;
}`;
}

export function applyStyle(doc: Document, settings: Settings): void {
  let style = doc.getElementById(STYLE_ID);
  if (!style) {
    style = doc.createElement('style');
    style.id = STYLE_ID;
    style.setAttribute(YILIN_ATTR, 'style');
    (doc.head ?? doc.documentElement).append(style);
  }
  style.textContent = buildStyle(settings);
  const mode: DisplayMode = settings.displayMode;
  if (mode === 'translation') doc.documentElement.setAttribute(MODE_ATTR, 'translation');
  else doc.documentElement.removeAttribute(MODE_ATTR);
}
