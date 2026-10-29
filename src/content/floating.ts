/**
 * Floating button for touch devices (doc/04 §4.3). A phone has no shortcut key, no right-click menu and
 * no hover, and the toolbar popup is awkward to reach, so the page carries its own entry point: tap to
 * translate or show the original; the small ⋯ button under it opens read-aloud and the display-mode
 * switch. Like the lookup bubble it lives in a shadow root and writes all text with textContent.
 */

import { RTL_LANGUAGES, createTranslator, resolveUiLang, type Translator } from '../shared/i18n';
import type { DisplayMode, Settings } from '../shared/settings';

export interface FloatingState {
  status: 'idle' | 'translating' | 'done' | 'stopped';
  /** Paragraphs translated so far; reading aloud is offered once there is something to read. */
  translated: number;
  speaking: boolean;
  displayMode: DisplayMode;
}

export interface FloatingActions {
  /** Translate when nothing is translated, otherwise show the original. */
  toggle(): void;
  toggleRead(): void;
  toggleMode(): void;
}

export interface FloatingDeps {
  settings: Settings;
  actions: FloatingActions;
  /** Where the button was left last time, as a fraction of the viewport height. */
  top?: number | null;
  saveTop?(top: number): void;
}

const HOST_ID = 'yilin-floating';
const DRAG_THRESHOLD_PX = 8;
const MIN_TOP = 0.12;
const MAX_TOP = 0.82;
const DEFAULT_TOP = 0.62;

interface IconSpec {
  size: number;
  /** Outline icons are stroked; filled ones (the dots) have a fill and no stroke. */
  filled?: boolean;
  paths?: { d: string; opacity?: string }[];
  circles?: { cx: number; cy: number; r: number }[];
}

const ICON_TRANSLATE: IconSpec = { size: 24, paths: [{ d: 'M4 6h16M4 10h10' }, { d: 'M4 15h16M4 19h10', opacity: '.55' }] };
const ICON_ORIGINAL: IconSpec = { size: 24, paths: [{ d: 'M9 14 4 9l5-5' }, { d: 'M4 9h10a6 6 0 0 1 0 12h-3' }] };
const ICON_MORE: IconSpec = { size: 20, filled: true, circles: [{ cx: 5, cy: 12, r: 2 }, { cx: 12, cy: 12, r: 2 }, { cx: 19, cy: 12, r: 2 }] };

/** Built node by node rather than from markup, so nothing is ever parsed from a string. */
function svgIcon(doc: Document, spec: IconSpec): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = doc.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(spec.size));
  svg.setAttribute('height', String(spec.size));
  svg.setAttribute('aria-hidden', 'true');
  if (spec.filled) {
    svg.setAttribute('fill', 'currentColor');
  } else {
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
  }
  for (const { d, opacity } of spec.paths ?? []) {
    const path = doc.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    if (opacity) path.setAttribute('opacity', opacity);
    svg.append(path);
  }
  for (const { cx, cy, r } of spec.circles ?? []) {
    const circle = doc.createElementNS(ns, 'circle');
    circle.setAttribute('cx', String(cx));
    circle.setAttribute('cy', String(cy));
    circle.setAttribute('r', String(r));
    svg.append(circle);
  }
  return svg;
}

const STYLE = `
:host { all: initial; }
.fab {
  --accent: #2f6f5e; --accent-hover: #285f50; --accent-tint: #e7f3ef; --ink: #1f2937;
  position: fixed; z-index: 2147483645; right: 8px; display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
  font: 14px/1.4 system-ui, "Microsoft YaHei", sans-serif; touch-action: none;
}
.fab[dir="rtl"] { right: auto; left: 8px; align-items: flex-start; }
button { font: inherit; cursor: pointer; border: 0; -webkit-tap-highlight-color: transparent; }
.ball {
  width: 48px; height: 48px; border-radius: 50%; display: grid; place-items: center; padding: 0;
  background: var(--accent); color: #fff; box-shadow: 0 4px 14px rgb(0 0 0 / 28%); opacity: 0.88; touch-action: none;
}
.ball:active { background: var(--accent-hover); }
.fab[data-status="done"] .ball { opacity: 1; }
.fab[data-status="translating"] .ball svg { display: none; }
.fab[data-status="translating"] .ball::after {
  content: ""; width: 22px; height: 22px; border-radius: 50%; border: 3px solid rgb(255 255 255 / 40%); border-top-color: #fff;
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.more {
  width: 36px; height: 36px; border-radius: 50%; display: grid; place-items: center; padding: 0;
  background: #fff; color: var(--ink); box-shadow: 0 2px 8px rgb(0 0 0 / 22%); opacity: 0.88;
}
.menu { display: flex; flex-direction: column; align-items: inherit; gap: 8px; }
.pill {
  min-height: 44px; padding: 0 16px; border-radius: 22px; white-space: nowrap;
  background: #fff; color: var(--ink); box-shadow: 0 2px 10px rgb(0 0 0 / 24%);
}
.pill:active { background: var(--accent-tint); }
.pill[data-on="true"] { background: var(--accent); color: #fff; }
[hidden] { display: none !important; }
`;

const clampTop = (top: number) => Math.min(MAX_TOP, Math.max(MIN_TOP, top));

export function createFloatingButton(doc: Document, deps: FloatingDeps) {
  let settings = deps.settings;
  let uiLang = resolveUiLang(settings.uiLang);
  let t: Translator = createTranslator(uiLang);
  let top = clampTop(deps.top ?? DEFAULT_TOP);
  let state: FloatingState = { status: 'idle', translated: 0, speaking: false, displayMode: settings.displayMode };
  let open = false;

  const host = doc.createElement('div');
  host.id = HOST_ID;
  host.setAttribute('data-yilin', 'floating');
  const shadow = host.attachShadow({ mode: 'open' });
  const style = doc.createElement('style');
  style.textContent = STYLE;

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string) => {
    const node = doc.createElement(tag);
    node.className = className;
    return node;
  };
  const button = (className: string) => {
    const b = el('button', className);
    b.type = 'button';
    return b;
  };

  const fab = el('div', 'fab');
  const menu = el('div', 'menu');
  const read = button('pill');
  const mode = button('pill');
  const hide = button('pill');
  menu.append(read, mode, hide);
  const ball = button('ball');
  const more = button('more');
  more.replaceChildren(svgIcon(doc, ICON_MORE));
  fab.append(menu, ball, more);
  shadow.append(style, fab);

  function place() {
    fab.style.top = `${Math.round(top * 100)}vh`;
  }

  function setOpen(next: boolean) {
    open = next;
    render();
  }

  function render() {
    const names: Record<DisplayMode, string> = { bilingual: t('display.bilingual'), translation: t('display.translation') };
    fab.dataset['status'] = state.status;
    fab.dir = RTL_LANGUAGES.has(uiLang) ? 'rtl' : 'ltr';
    const translated = state.status === 'done' || state.status === 'translating' || state.translated > 0;
    // The icon says what a tap will do: translate, or go back to the original.
    ball.replaceChildren(svgIcon(doc, translated ? ICON_ORIGINAL : ICON_TRANSLATE));
    const label = translated ? t('action.restore') : t('action.translate');
    ball.setAttribute('aria-label', label);
    ball.title = label;
    more.setAttribute('aria-label', t('float.more'));
    more.setAttribute('aria-expanded', String(open));
    menu.hidden = !open;
    read.hidden = state.translated === 0;
    read.textContent = state.speaking ? t('tts.stop') : t('tts.read');
    read.dataset['on'] = String(state.speaking);
    // The pill names the mode a tap switches to.
    mode.textContent = state.displayMode === 'bilingual' ? names.translation : names.bilingual;
    hide.textContent = t('float.hide');
  }

  // Dragging moves the button up and down along the edge so it can be put out of the way of the page.
  let dragFrom: { y: number; top: number } | null = null;
  let dragged = false;
  ball.addEventListener('pointerdown', (e) => {
    dragFrom = { y: e.clientY, top };
    dragged = false;
    ball.setPointerCapture?.(e.pointerId);
  });
  ball.addEventListener('pointermove', (e) => {
    if (!dragFrom) return;
    const dy = e.clientY - dragFrom.y;
    if (!dragged && Math.abs(dy) > DRAG_THRESHOLD_PX) dragged = true;
    if (dragged) {
      top = clampTop(dragFrom.top + dy / (doc.defaultView?.innerHeight || 800));
      place();
    }
  });
  const endDrag = () => {
    if (dragged) deps.saveTop?.(top);
    dragFrom = null;
  };
  ball.addEventListener('pointerup', endDrag);
  ball.addEventListener('pointercancel', endDrag);
  ball.addEventListener('click', () => {
    // The click that ends a drag is not a tap.
    if (dragged) {
      dragged = false;
      return;
    }
    setOpen(false);
    deps.actions.toggle();
  });

  more.addEventListener('click', () => setOpen(!open));
  read.addEventListener('click', () => {
    setOpen(false);
    deps.actions.toggleRead();
  });
  mode.addEventListener('click', () => {
    setOpen(false);
    deps.actions.toggleMode();
  });
  hide.addEventListener('click', () => dispose());

  // Tapping anywhere else folds the menu away.
  const onOutside = (event: Event) => {
    if (open && !event.composedPath().includes(host)) setOpen(false);
  };
  doc.addEventListener('pointerdown', onOutside, true);

  function dispose() {
    doc.removeEventListener('pointerdown', onOutside, true);
    host.remove();
  }

  place();
  render();
  doc.documentElement.append(host);

  return {
    update(next: FloatingState) {
      state = next;
      render();
    },
    updateSettings(next: Settings) {
      settings = next;
      uiLang = resolveUiLang(settings.uiLang);
      t = createTranslator(uiLang);
      render();
    },
    dispose,
    /** Tests drive the flow through these rather than through real pointer gestures. */
    _internals: { shadow, host },
  };
}
