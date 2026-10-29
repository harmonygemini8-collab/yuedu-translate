import { YILIN_ATTR } from './extractor';

const TRANSLATION = `[${YILIN_ATTR}="translation"][data-state="done"]:not([data-compact])`;
const CONTAINERS = 'main, [role="main"], article';
// Page furniture inside the content area: related-story rails, share bars, tab strips, footers.
// <header> is deliberately absent: an article's own title block is usually <article><header>.
const FURNITURE =
  'nav, aside, footer, form, a, button, label, summary, time, figcaption, [rel="author"], [role="navigation"], [role="menu"], [role="menubar"], [role="tablist"], [role="toolbar"], [role="banner"], [role="complementary"], [role="button"], [aria-hidden="true"]';

export interface ReadableText {
  text: string;
  lang: string;
}

const charsOf = (nodes: HTMLElement[]) => nodes.reduce((n, el) => n + (el.textContent?.length ?? 0), 0);

/** The container (article, else main) that holds most of the translated text on the page. */
function pickRoot(doc: Document, nodes: HTMLElement[]): Element | null {
  const outermost = [...doc.querySelectorAll(CONTAINERS)].filter((el) => !el.parentElement?.closest(CONTAINERS));
  const holding = (root: Element) => nodes.filter((n) => root.contains(n));
  let best: Element | null = null;
  let bestChars = 0;
  for (const root of outermost) {
    const chars = charsOf(holding(root));
    if (chars > bestChars) [best, bestChars] = [root, chars];
  }
  if (!best) return null;
  // A main holding several articles keeps only the one the reader is in; a main wrapping one article narrows to it.
  let narrowed: Element | null = null;
  let narrowedChars = 0;
  for (const article of best.querySelectorAll('article')) {
    const chars = charsOf(holding(article));
    if (chars > narrowedChars) [narrowed, narrowedChars] = [article, chars];
  }
  return narrowed && narrowedChars >= bestChars * 0.5 ? narrowed : best;
}

/** Every translated paragraph on the page that is not menu, link or button text, whichever article it belongs to. */
export function translatedBodyNodes(doc: Document): HTMLElement[] {
  return [...doc.querySelectorAll<HTMLElement>(TRANSLATION)].filter((el) => !el.parentElement?.closest(FURNITURE));
}

/**
 * The container of the article being read, or null when the page has no article or main landmark.
 * `near` is the paragraph the reader is at: the article that holds it is the one to read, even when
 * another article on the page has collected more translated text.
 */
export function readableRoot(doc: Document, near?: Element | null): Element | null {
  if (near) {
    // Same shape as the page-wide choice: the outermost main (or, without one, article) around it, narrowed to its article.
    const main = near.closest('main, [role="main"]');
    const scope: Element | null = main ?? near;
    let outer: Element | null = null;
    for (let el: Element | null = near.parentElement; el && (!main || main.contains(el)); el = el.parentElement) {
      if (el.tagName === 'ARTICLE') outer = el;
    }
    const around = outer ?? main ?? (scope === near ? null : scope);
    if (around) return around;
  }
  const nodes = [...doc.querySelectorAll<HTMLElement>(TRANSLATION)];
  return nodes.length === 0 ? null : pickRoot(doc, nodes);
}

/**
 * Translation nodes of the article in reading order: title and body, without menus, link lists or page chrome.
 * `pinned` fixes the article: a reader that follows the page down must not drift into the next article just
 * because that one has since collected more translated text.
 */
export function collectReadableNodes(doc: Document, pinned?: Element | null): HTMLElement[] {
  const nodes = [...doc.querySelectorAll<HTMLElement>(TRANSLATION)];
  if (nodes.length === 0) return [];
  const root = pinned ?? pickRoot(doc, nodes);
  const inFurniture = (el: HTMLElement) => !!el.parentElement?.closest(FURNITURE);
  return nodes.filter((el) => {
    if (inFurniture(el)) return false;
    if (root) return root.contains(el) || !!el.parentElement?.closest('h1');
    return !el.parentElement?.closest('header, [role="banner"]');
  });
}

export function collectReadableText(doc: Document): ReadableText | null {
  const picked = collectReadableNodes(doc);
  const text = picked
    .map((n) => n.textContent?.trim() ?? '')
    .filter(Boolean)
    .join('\n');
  return text ? { text, lang: picked[0]?.lang || 'zh-CN' } : null;
}
