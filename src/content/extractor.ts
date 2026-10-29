export const YILIN_ATTR = 'data-yilin';
export const SEGMENT_ATTR = 'data-yilin-id';
/** Wrapper we put around one visual paragraph of a block that separates them with <br>. */
export const LINE_ATTR = 'data-yilin-line';

/** Elements that are always a paragraph of their own when they carry text. */
const PROSE_TAGS = new Set([
  'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE', 'DD', 'DT',
  'TD', 'TH', 'FIGCAPTION', 'SUMMARY', 'CAPTION',
]);

/** Generic wrappers that only count as a paragraph when they hold text directly or only inline content. */
const CONTAINER_TAGS = new Set(['DIV', 'SECTION', 'ARTICLE', 'ASIDE', 'HEADER', 'MAIN', 'FIGURE', 'ADDRESS', 'CENTER']);

const BLOCK_TAGS = new Set([...PROSE_TAGS, ...CONTAINER_TAGS,
  'UL', 'OL', 'DL', 'TABLE', 'TR', 'PRE', 'HR', 'NAV', 'FOOTER', 'DETAILS', 'FORM', 'FIELDSET']);

import type { Scope } from '../shared/settings';

/** Subtrees whose text is never read or translated, in any mode: code, form values, media. */
const ALWAYS_EXCLUDED_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'PRE', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION',
  'svg', 'SVG', 'math', 'MATH', 'CANVAS', 'IFRAME',
]);
/** Main-text mode also skips page chrome. */
const ARTICLE_EXCLUDED_TAGS = new Set([...ALWAYS_EXCLUDED_TAGS, 'BUTTON', 'LABEL', 'NAV', 'FOOTER']);
const ARTICLE_EXCLUDED_ROLES = new Set([
  'navigation', 'button', 'toolbar', 'tablist', 'tab', 'menu', 'menubar', 'banner', 'contentinfo', 'search',
]);
/** Whole-page mode: interface elements are paragraphs of their own. */
const PAGE_PROSE_TAGS = new Set([...PROSE_TAGS, 'BUTTON', 'LABEL', 'LEGEND']);
/** Interface elements whose translation is shown compactly in whole-page mode. */
const COMPACT_TAGS = new Set(['BUTTON', 'LABEL', 'LEGEND', 'A', 'TH', 'DT', 'SUMMARY', 'CAPTION']);
const CHROME_SELECTOR =
  'nav, header, footer, aside, [role="navigation"], [role="menu"], [role="menubar"], [role="tablist"], [role="toolbar"], [role="banner"]';
const EDITABLE = new Set(['', 'true', 'plaintext-only']);

/**
 * A reference list entry (LaTeXML: `<li class="ltx_bibitem">` with a tag and three `ltx_bibblock`s) is authors, title, venue.
 * The authors (the first block) are left as they are: engines turn names into half-transliterations. So is a block that is
 * all italic ("arXiv preprint arXiv:1808.04444"), which is a name, not a sentence. Title and venue ("In Proceedings of …,
 * pages 120–128.") are translated, each as its own paragraph.
 */
function isReferenceNoise(el: Element): boolean {
  if (el.classList.contains('ltx_tag_bibitem')) return true;
  if (!el.classList.contains('ltx_bibblock')) return false;
  const blocks = [...(el.parentElement?.children ?? [])].filter((c) => c.classList.contains('ltx_bibblock'));
  if (blocks[0] === el) return true;
  const length = (el.textContent ?? '').trim().length;
  const italic = [...el.querySelectorAll('.ltx_font_italic')].reduce((n, e) => n + (e.textContent ?? '').length, 0);
  return length > 0 && italic >= length * 0.9;
}

/** Plain attribute checks instead of one large selector: this runs for every element on the page. */
function isExcludedElement(el: Element, scope: Scope = 'article'): boolean {
  if ((scope === 'page' ? ALWAYS_EXCLUDED_TAGS : ARTICLE_EXCLUDED_TAGS).has(el.tagName)) return true;
  if (el.attributes.length === 0) return false;
  const role = el.getAttribute('role');
  const editable = el.getAttribute('contenteditable');
  return (
    (scope === 'article' && role !== null && ARTICLE_EXCLUDED_ROLES.has(role)) ||
    (editable !== null && EDITABLE.has(editable.toLowerCase())) ||
    el.getAttribute('translate') === 'no' ||
    el.classList.contains('notranslate') ||
    // A video player's own captions are the subtitle feature's business; read as page text they are
    // translated a second time, under the player's caption, next to the subtitle translation.
    el.classList.contains('ytp-caption-window-container') ||
    el.classList.contains('caption-window') ||
    isReferenceNoise(el) ||
    el.hasAttribute(YILIN_ATTR)
  );
}

/** Formatting and link wrappers: a span inside one belongs to the paragraph around it. (A plain span is not on the list: pages use those as layout wrappers.) */
const INLINE_WRAPPERS = new Set([
  'A', 'EM', 'I', 'B', 'STRONG', 'SMALL', 'SUB', 'SUP', 'U', 'MARK', 'ABBR', 'CITE', 'Q', 'S', 'DEL', 'INS',
  'FONT', 'BDI', 'BDO', 'DFN', 'TIME', 'LABEL', 'CODE', 'KBD', 'SAMP', 'VAR', 'TT',
]);

/** Inline elements whose text is code rather than prose. */
const CODE_TAGS = new Set(['CODE', 'KBD', 'SAMP', 'VAR', 'TT']);

/**
 * Words in class/id names that mark page chrome rather than content
 * (matched as whole words, so "ad" matches "ad-slot" but not "header").
 */
const NOISE_WORDS = new Set([
  'nav', 'navbar', 'navigation', 'menu', 'breadcrumb', 'breadcrumbs', 'sidebar', 'toc', 'toolbar', 'skip',
  'cookie', 'cookies', 'consent', 'gdpr', 'share', 'sharing', 'ad', 'ads', 'advert', 'advertisement',
  'sponsor', 'sponsored', 'promo', 'newsletter', 'subscribe', 'subscription', 'cta', 'pagination', 'pager',
  'related', 'meta', 'footer', 'reply',
]);

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/gu;
const KANA = /[\u3040-\u30ff]/u;
const LETTERS = /\p{L}/gu;
/** A single token that looks like an identifier, path, URL, handle or call: `a.b`, `x_y`, `f()`, `@user`. */
const CODE_LIKE_TOKEN = /\w[._/\\@:]\w|\(\)|^[@#]\w/;
const CONTENT_ROOT_SELECTOR = 'main, [role="main"], article';

export const normalizeText = (text: string) => text.replace(/\s+/g, ' ').trim();

/** FNV-1a; only used to detect that a paragraph's text changed. */
export function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

const countLetters = (text: string) => text.match(LETTERS)?.length ?? 0;
const isOwnNode = (node: Node) => node instanceof Element && node.hasAttribute(YILIN_ATTR);
const hasLooseText = (el: Element) =>
  [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim() !== '');

/**
 * Per-pass memo of structural facts, so a full-page scan stays roughly linear
 * in the number of elements instead of re-walking subtrees for every element.
 */
class Pass {
  constructor(readonly scope: Scope = 'article') {}

  private block = new Map<Element, boolean>();
  private candidate = new Map<Element, boolean>();
  private excluded = new Map<Element, boolean>();
  private hidden = new Map<Element, boolean>();
  private hiddenAttr = new Map<Element, boolean>();
  private noise = new Map<Element, boolean>();

  private memo<T>(cache: Map<Element, T>, el: Element, compute: () => T): T {
    let value = cache.get(el);
    if (value === undefined) {
      value = compute();
      cache.set(el, value);
    }
    return value;
  }

  /**
   * An empty decorative wrapper (an icon's `<div>`, a spacer) must not count: it holds no text of
   * its own and never becomes a candidate, so letting it block the container only loses that
   * container's text with nothing taking its place (seen on a listing site where the real prose
   * sat in bare `<span>`s next to one such wrapper, and vanished entirely).
   */
  hasBlockDescendant(el: Element): boolean {
    return this.memo(this.block, el, () =>
      [...el.children].some((c) => (BLOCK_TAGS.has(c.tagName) && (c.textContent ?? '').trim() !== '') || this.hasBlockDescendant(c)),
    );
  }

  isCandidate(el: Element): boolean {
    return this.memo(this.candidate, el, () => {
      // Our own line wrappers are paragraphs by construction, so a parent's text never swallows them.
      if (el.hasAttribute(LINE_ATTR)) return true;
      // Each block of a reference entry is its own paragraph; the entry around them is not.
      if (el.classList.contains('ltx_bibblock')) return true;
      if (el.classList.contains('ltx_bibitem')) return false;
      // A LaTeXML footnote's text (arXiv HTML): ar5iv renders it as a permanently visible side-note, not a
      // hover tooltip, so it is read like any other paragraph — its own segment, not absorbed into the sentence
      // that carries the footnote mark (which would duplicate it inline; doc/12 §13.3).
      if (el.classList.contains('ltx_note_content')) return true;
      if ((this.scope === 'page' ? PAGE_PROSE_TAGS : PROSE_TAGS).has(el.tagName)) return true;
      // A stand-alone link (a menu item, not a link inside a sentence) is its own item in whole-page mode.
      // A link in the middle of a sentence ("described in <cite><a>Vaswani et al. 2017</a></cite> and ...") is part
      // of it, however many formatting wrappers sit between: the container to ask is the first that is not one.
      if (this.scope === 'page' && el.tagName === 'A') {
        let container = el.parentElement;
        while (container && INLINE_WRAPPERS.has(container.tagName) && !hasLooseText(container)) container = container.parentElement;
        return !!container && !hasLooseText(container);
      }
      // A <span> normally merges into its container (as inline text inside a sentence does), but
      // when the container cannot merge — real block content sits beside it, like a price box or
      // another paragraph — the span is the only thing left to carry its own text: a listing's
      // title written as a bare <span> next to its price and description <div>s (acquire.com).
      // The container is the nearest ancestor that is not itself an inline wrapper: the "1" in
      // `<p>… Figure <a><span>1</span></a>, …</p>` belongs to the paragraph, not to a paragraph of its own.
      if (el.tagName === 'SPAN' && hasLooseText(el)) return !this.mergesIntoContainer(el);
      if (!CONTAINER_TAGS.has(el.tagName)) return false;
      return hasLooseText(el) || (!this.hasBlockDescendant(el) && (el.textContent ?? '').trim() !== '');
    });
  }

  /** Whether the text of an inline element is read as part of a paragraph around it. */
  private mergesIntoContainer(el: Element): boolean {
    for (let parent = el.parentElement; parent; parent = parent.parentElement) {
      if (this.isCandidate(parent)) return true;
      if (!INLINE_WRAPPERS.has(parent.tagName)) return false;
    }
    return false;
  }

  isExcluded(el: Element | null): boolean {
    if (!el) return false;
    return this.memo(this.excluded, el, () => isExcludedElement(el, this.scope) || this.isExcluded(el.parentElement));
  }

  /** `hidden` and `aria-hidden` apply to the whole subtree, which checkVisibility knows nothing about. */
  private hasHiddenAttribute(el: Element | null): boolean {
    if (!el) return false;
    return this.memo(this.hiddenAttr, el, () =>
      el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true' || this.hasHiddenAttribute(el.parentElement));
  }

  isHidden(el: Element): boolean {
    return this.memo(this.hidden, el, () => {
      if (this.hasHiddenAttribute(el)) return true;
      const parent = el.parentElement;
      if (typeof el.checkVisibility === 'function') {
        if (el.checkVisibility({ visibilityProperty: true })) return false;
        // checkVisibility already accounts for ancestors, so its answer must not be ORed up the tree:
        // a `display: contents` wrapper reports itself as not visible while its children do render,
        // and whole UI frameworks wrap the page in such elements.
        const display = el.ownerDocument.defaultView?.getComputedStyle(el).display;
        return display !== 'contents' || (!!parent && this.isHidden(parent));
      }
      // Fallback (jsdom): `visibility` is inherited in computed style, `display: none` is not.
      const style = el.ownerDocument.defaultView?.getComputedStyle(el);
      return style?.display === 'none' || style?.visibility === 'hidden' || (!!parent && this.isHidden(parent));
    });
  }

  isInNoise(el: Element | null): boolean {
    if (this.scope === 'page' || !el || el === el.ownerDocument.body) return false;
    return this.memo(this.noise, el, () => hasNoiseName(el) || this.isInNoise(el.parentElement));
  }

  hasCandidateDescendant(el: Element): boolean {
    for (const child of el.querySelectorAll('*')) {
      if (this.isCandidate(child) && !this.isExcluded(child)) return true;
    }
    return false;
  }
}

/**
 * Text that is not inside a link. Page chrome is mostly links and short labels, so this separates
 * a "reply" button from a support ticket's replies, which carry the same word in their class name.
 */
function unlinkedTextLength(el: Element): number {
  let linked = 0;
  for (const link of el.querySelectorAll('a')) linked += (link.textContent ?? '').length;
  return (el.textContent ?? '').length - linked;
}

/** A sentence this long is prose; labels, bylines and buttons stay well under it. */
const SENTENCE_CHARS = 80;

/**
 * Whether one unbroken run of text this long sits outside any link. A single run rather than the
 * total, so a column of short labels does not add up to a paragraph; and text rather than tags,
 * because prose is written as often between `<br>` elements as inside `<p>` ones.
 */
function holdsSentence(node: Node): boolean {
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      if (normalizeText(child.textContent ?? '').length >= SENTENCE_CHARS) return true;
    } else if (child instanceof Element && child.tagName !== 'A' && holdsSentence(child)) {
      return true;
    }
  }
  return false;
}

function hasNoiseName(el: Element): boolean {
  const names = `${el.getAttribute('class') ?? ''} ${el.id}`.toLowerCase();
  if (!names.split(/\s+/).some((name) => name.split(/[-_]+/).some((word) => NOISE_WORDS.has(word)))) return false;
  // Main content wrappers sometimes carry names like "newsletter-post"; never discard them.
  if (el.matches(CONTENT_ROOT_SELECTOR) || el.querySelector(CONTENT_ROOT_SELECTOR)) return false;
  // A support ticket's replies live in "ticket-reply" next to a "reply" button: the class name is
  // the same, the content is not. Whole sentences mean this block is being read, not operated.
  return !holdsSentence(el);
}

/**
 * A formula written inside a sentence (MathML, KaTeX, MathJax). It is not text to translate, but the sentence
 * cannot be read without it ("where pos is the position"), so it is sent as a numbered placeholder and put
 * back, as the page's own formula, where the translation puts the placeholder.
 */
export function isInlineMath(el: Element): boolean {
  // Subscripts and superscripts (BERT<sub>BASE</sub>, a footnote mark) are kept as the page wrote them.
  return el.localName === 'sub' || el.localName === 'sup' || el.localName === 'math' || el.localName === 'mjx-container' || el.classList.contains('katex')
    || el.classList.contains('MathJax') || el.classList.contains('ltx_Math');
}

export const mathToken = (n: number) => `[[${n}]]`;
/**
 * The placeholder as an engine hands it back: now and then one bracket is lost or a space appears, and a
 * placeholder left unread would leave a stray bracket in the sentence and the formula at its end.
 */
export const MATH_TOKEN = /\[\s*\[\s*(\d+)\s*\](?:\s*\])?|(?<!\[)\[\s*(\d+)\s*\]\s*\]/g;

interface SegmentAnalysis {
  /** The formulas inside the sentence, in order; placeholder `[[n]]` in the text stands for `math[n - 1]`. */
  math: Element[];
  text: string;
  /** Letters outside code/kbd elements. */
  proseLetters: number;
  /** Letters outside links. */
  unlinkedLetters: number;
  links: number;
}

/**
 * Collect the text that belongs to this paragraph: everything inside it except nested
 * paragraphs (e.g. a sub-list inside an <li>), excluded subtrees and our own nodes.
 */
function analyze(el: Element, pass: Pass): SegmentAnalysis {
  const result: SegmentAnalysis = { math: [], text: '', proseLetters: 0, unlinkedLetters: 0, links: 0 };
  const walk = (node: Node, inCode: boolean, inLink: boolean) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = child.textContent ?? '';
        result.text += text;
        const letters = countLetters(text);
        if (!inCode) result.proseLetters += letters;
        if (!inLink) result.unlinkedLetters += letters;
      } else if (child instanceof Element && isInlineMath(child)) {
        // Math/MathML is foreign content: computed style on it is unreliable (and throws under jsdom), so it
        // is never checked for being hidden — same as before this check existed.
        result.math.push(child);
        result.text += mathToken(result.math.length);
      } else if (child instanceof Element && pass.isHidden(child)) {
        // Not read, not translated: a sighted reader never sees it either (LaTeXML leaves `display:none`
        // backref markers — a stray "1" — inside a footnote's own text; seen on ar5iv, doc/24 §3).
        continue;
      } else if (child instanceof Element && !isExcludedElement(child, pass.scope)) {
        const nested = pass.isCandidate(child);
        if (nested || child.tagName === 'BR') result.text += ' ';
        if (nested) continue;
        if (child.tagName === 'A') result.links++;
        walk(child, inCode || CODE_TAGS.has(child.tagName), inLink || child.tagName === 'A');
      }
    }
  };
  walk(el, false, false);
  result.text = normalizeText(result.text);
  return result;
}

/** The formulas the placeholders in `segmentText` stand for. */
export const segmentMath = (el: Element, scope: Scope = 'article') => analyze(el, new Pass(scope)).math;

/** Must use the same scope as the extraction, or the text (and its fingerprint) would differ. */
export const segmentText = (el: Element, scope: Scope = 'article') => analyze(el, new Pass(scope)).text;

/** Translations go before the first nested paragraph so they stay next to their own text. */
export function insertionPoint(el: Element): Node | null {
  const pass = new Pass();
  for (const child of el.children) {
    if (isOwnNode(child)) continue;
    // A footnote mark sitting inline in a sentence ("…gradients¹. To counteract…") has its own candidate
    // descendant (.ltx_note_content) now that it is translated on its own — but it is not a nested paragraph
    // of the sentence around it, just an aside hanging off one word. Treating it as "where to insert before"
    // put the sentence's translation in the middle of the sentence, ahead of the words that follow the mark.
    if (child.classList.contains('ltx_note')) continue;
    if (pass.isCandidate(child)) return child;
    // A wrapper with text of its own and a nested paragraph after it (a "See less" toggle): the
    // translation goes inside it, after that text, not above the whole wrapper.
    if (pass.hasCandidateDescendant(child)) return hasLooseText(child) ? insertionPoint(child) ?? child : child;
  }
  return null;
}

function isMostlyChinese(text: string): boolean {
  if (KANA.test(text)) return false;
  const cjk = text.match(CJK)?.length ?? 0;
  const latinWords = text.match(/[A-Za-z]+/g)?.length ?? 0;
  // One Chinese character carries roughly half a word of meaning.
  return cjk > 0 && cjk / 2 >= latinWords;
}

const ARABIC = /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb50-\ufdff\ufe70-\ufeff]/gu;
/** Letters that only Vietnamese uses among Latin-script languages (ơ, ư, đ and tone-marked vowels). */
const VIETNAMESE = /[ăđơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/giu;

const isMostlyArabic = (text: string) => (text.match(ARABIC)?.length ?? 0) / Math.max(1, countLetters(text)) > 0.5;

function isVietnamese(text: string): boolean {
  const words = text.match(/\p{L}+/gu)?.length ?? 0;
  return words > 0 && (text.match(VIETNAMESE)?.length ?? 0) / words >= 0.3;
}

/** Text already in the target language is left alone. Malay (plain Latin script) cannot be detected reliably. */
function isAlreadyTarget(text: string, targetLang: string): boolean {
  if (targetLang.startsWith('zh') || targetLang === 'yue') return isMostlyChinese(text);
  if (targetLang === 'ar') return isMostlyArabic(text);
  if (targetLang === 'vi') return isVietnamese(text);
  return false;
}

export function shouldTranslate(text: string, targetLang: string): boolean {
  if (countLetters(text) < 2) return false;
  if (!/\s/.test(text) && CODE_LIKE_TOKEN.test(text)) return false;
  return !isAlreadyTarget(text, targetLang);
}

function isWorthTranslating({ text, proseLetters, unlinkedLetters, links }: SegmentAnalysis, targetLang: string, scope: Scope): boolean {
  if (proseLetters === 0) return false;
  // A run of links with no other text is a menu: skipped in main-text mode, wanted in whole-page mode.
  if (scope === 'article' && links >= 3 && unlinkedLetters === 0) return false;
  return shouldTranslate(text, targetLang);
}

export interface ExtractedSegment {
  el: Element;
  text: string;
  /** Interface text (menu item, button, label…) whose translation is shown small, without the marker line. */
  compact: boolean;
}

const SHORT_LABEL_CHARS = 40;

/**
 * Short interface text (menu item, button, label, short heading) is shown inline after the original.
 * Anything longer, even inside a sidebar or header, is a sentence and gets the normal block translation.
 */
function isCompact(el: Element, text: string, scope: Scope): boolean {
  if (scope !== 'page' || text.length > SHORT_LABEL_CHARS) return false;
  return COMPACT_TAGS.has(el.tagName) || !!el.closest(CHROME_SELECTOR) || !/[.!?。！？]$/.test(text);
}

/**
 * Some pages write paragraphs as loose text separated by <br><br> inside a single element — ticket
 * systems and plain-text mail renderers do it constantly. Treated as one element that is one
 * segment, and the whole block gets a single translation dumped after the signature. Each visual
 * paragraph is wrapped in a span of ours instead, so it becomes a paragraph like any other and its
 * translation lands directly beneath it. Wrapping is skipped unless it actually yields two.
 */
function splitOnBreaks(el: Element): Element[] {
  const existing = [...el.children].filter((c) => c.hasAttribute(LINE_ATTR));
  if (existing.length > 0) return existing;
  if (!hasLooseText(el)) return [];

  const runs: Node[][] = [[]];
  let pending: Node[] = [];
  for (const node of [...el.childNodes]) {
    if (node instanceof Element && node.tagName === 'BR') {
      pending.push(node);
      // A single break is a line inside one paragraph; two or more start a new one, and those
      // breaks stay outside the wrappers so the page keeps the blank line between paragraphs.
      if (pending.length >= 2 && runs.at(-1)!.length > 0) {
        runs.push([]);
        pending = [];
      }
      continue;
    }
    if (node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() === '') continue;
    if (runs.at(-1)!.length > 0) runs.at(-1)!.push(...pending);
    pending = [];
    runs.at(-1)!.push(node);
  }

  const filled = runs.filter((run) => run.length > 0);
  if (filled.length < 2) return [];
  return filled.map((run) => {
    const wrapper = el.ownerDocument.createElement('span');
    // A plain inline span: the run was inline text between the breaks and still is, so the page's
    // own spacing survives, and the translation block below it is laid out as in any paragraph.
    wrapper.setAttribute(LINE_ATTR, '');
    el.insertBefore(wrapper, run[0]!);
    wrapper.append(...run);
    return wrapper;
  });
}

/**
 * Some pages write a whole block — paragraphs and bullet-style lines alike — as one plain-text
 * blob with literal `\n` characters, relying on CSS (`white-space: pre-line`) to show the line
 * breaks, instead of real `<br>` elements (a listing's description copied verbatim from a CMS
 * field, acquire.com). Unlike `splitOnBreaks`, every line is its own segment here: there is no
 * "wrapped prose line" case to merge back together, each `\n`-separated line already reads as its
 * own sentence or bullet. The `\n` runs themselves stay in place between the wrappers, so
 * unwrapping on restore puts the exact original text back — split across a few Text nodes instead
 * of one, which no page notices.
 */
const NEWLINE_PRESERVING = new Set(['pre', 'pre-line', 'pre-wrap', 'break-spaces']);

/**
 * The non-empty lines of a text node, but only where the page's CSS really shows `\n` as a line
 * break. In ordinary HTML a newline in the source is collapsed whitespace, and source-wrapped
 * paragraphs are everywhere; splitting those would cut sentences in two.
 */
function newlineLines(node: Node, host: Element): string[] {
  const text = node.textContent ?? '';
  if (!text.includes('\n')) return [];
  const lines = text.split(/\n+/).filter((s) => s.trim() !== '');
  if (lines.length < 2) return [];
  const whiteSpace = host.ownerDocument.defaultView?.getComputedStyle(host).whiteSpace ?? '';
  return NEWLINE_PRESERVING.has(whiteSpace) ? lines : [];
}

/**
 * Wraps each line of a direct text node of `el` in a span of ours. The `\n` runs stay in place
 * between the wrappers, so unwrapping on restore puts the exact original text back, split across
 * a few Text nodes instead of one, which no page notices.
 */
function splitOnNewlines(el: Element): Element[] {
  const made: Element[] = [];
  for (const node of [...el.childNodes]) {
    if (node.nodeType !== Node.TEXT_NODE || newlineLines(node, el).length < 2) continue;
    const fragment = el.ownerDocument.createDocumentFragment();
    for (const [i, piece] of (node.textContent ?? '').split(/(\n+)/).entries()) {
      if (i % 2 === 1 || piece.trim() === '') {
        if (piece !== '') fragment.append(piece);
        continue;
      }
      const wrapper = el.ownerDocument.createElement('span');
      wrapper.setAttribute(LINE_ATTR, '');
      wrapper.textContent = piece;
      fragment.append(wrapper);
      made.push(wrapper);
    }
    el.replaceChild(fragment, node);
  }
  return made;
}

/**
 * Elements inside a candidate that hold such a newline-separated blob as their own text: the
 * candidate itself, or a plain inline wrapper a level or two down with a "show more" toggle beside
 * it. Nested candidates are left to their own turn.
 */
function findTextBlobHosts(el: Element, pass: Pass, out: Element[] = []): Element[] {
  if ([...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && newlineLines(n, el).length >= 2)) out.push(el);
  for (const child of el.children) {
    if (child.tagName === 'BR' || child.hasAttribute(YILIN_ATTR) || isExcludedElement(child, pass.scope) || pass.isCandidate(child)) continue;
    findTextBlobHosts(child, pass, out);
  }
  return out;
}

function collect(roots: Element[], targetLang: string, pass: Pass): ExtractedSegment[] {
  const result: ExtractedSegment[] = [];
  const seen = new Set<Element>();
  for (const root of roots) {
    for (const el of [root, ...root.querySelectorAll('*')]) {
      if (!pass.isCandidate(el) || pass.isExcluded(el) || pass.isInNoise(el) || pass.isHidden(el)) continue;
      const brParts = splitOnBreaks(el);
      // A <br>-split block is replaced by its parts; a newline blob inside an element leaves that
      // element's remaining text (a title next to it) as a paragraph of its own.
      const parts = brParts.length > 0 ? brParts : [el, ...findTextBlobHosts(el, pass).flatMap(splitOnNewlines)];
      for (const part of parts) {
        if (seen.has(part)) continue;
        seen.add(part);
        const analysis = analyze(part, pass);
        if (isWorthTranslating(analysis, targetLang, pass.scope)) {
          // A label that holds paragraphs of its own is no short label: its translation sits before them.
          const compact = isCompact(part, analysis.text, pass.scope) && !pass.hasCandidateDescendant(part);
          result.push({ el: part, text: analysis.text, compact });
        }
      }
    }
  }
  return result;
}

/**
 * Prefer the page's main content area. Falls back to the whole body when the
 * page has no such landmark or when it holds only a small part of the text.
 */
function contentRoots(body: HTMLElement, pass: Pass): Element[] {
  const outermost = (selector: string) =>
    [...body.querySelectorAll(selector)].filter((el) => !el.parentElement?.closest(selector) && !pass.isHidden(el));
  const mains = outermost('main, [role="main"]');
  return mains.length > 0 ? mains : outermost('article');
}

const MIN_MAIN_CONTENT_SHARE = 0.25;

export function extractSegments(root: ParentNode, targetLang: string, scope: Scope = 'article'): ExtractedSegment[] {
  const pass = new Pass(scope);
  const body = root instanceof Element ? root.ownerDocument.body : null;
  if (!body || root !== body) {
    const roots = root instanceof Element ? [root] : [...root.children];
    return collect(roots, targetLang, pass);
  }
  const all = collect([body], targetLang, pass);
  if (scope === 'page') return all;
  const scopes = contentRoots(body, pass);
  if (scopes.length === 0) return all;
  const scoped = all.filter(({ el }) => scopes.some((scope) => scope.contains(el)));
  const chars = (list: ExtractedSegment[]) => list.reduce((n, s) => n + s.text.length, 0);
  return chars(scoped) >= chars(all) * MIN_MAIN_CONTENT_SHARE ? scoped : all;
}
