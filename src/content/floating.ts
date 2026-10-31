/**
 * Floating button for touch devices (doc/04 §4.3). A phone has no shortcut key, no right-click menu and
 * no hover, and the toolbar popup is awkward to reach, so the page carries its own entry point: tap the
 * logo to translate or show the original. A small gear sits under it for read-aloud, the display switch
 * and selection lookup — on a mouse it only appears on hover (with a light scale/fade), since there is
 * room to spare; on a touch screen, which has no hover, it stays visible the way it always has. Like the
 * lookup bubble it lives in a shadow root and writes all text with textContent.
 */

import { RTL_LANGUAGES, createTranslator, resolveUiLang, type Translator } from '../shared/i18n';
import type { DisplayMode, Settings } from '../shared/settings';
import { brandIcon } from './subtitle-panel';

export interface FloatingState {
  status: 'idle' | 'translating' | 'done' | 'stopped';
  /** Paragraphs translated so far; reading aloud is offered once there is something to read. */
  translated: number;
  speaking: boolean;
  displayMode: DisplayMode;
  /** Whether this site is on the auto-translate list right now. */
  autoTranslateHere: boolean;
}

export interface FloatingActions {
  /** Translate when nothing is translated, otherwise show the original. */
  toggle(): void;
  toggleRead(): void;
  toggleMode(): void;
  toggleSelectionLookup(): void;
  toggleAutoTranslateSite(): void;
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

const SVG_NS = 'http://www.w3.org/2000/svg';

/** A plain gear, for the settings button — distinct from the brand mark on the main button. */
function gearIcon(doc: Document, size = 18): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const circle = doc.createElementNS(SVG_NS, 'circle');
  circle.setAttribute('cx', '12');
  circle.setAttribute('cy', '12');
  circle.setAttribute('r', '3');
  svg.append(circle);
  const path = doc.createElementNS(SVG_NS, 'path');
  path.setAttribute(
    'd',
    'M19.4 13a7.6 7.6 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.5 7.5 0 0 0-1.7-1l-.4-2.6H9.1l-.4 2.6a7.5 7.5 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.6a7.6 7.6 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7.5 7.5 0 0 0 1.7 1l.4 2.6h4.8l.4-2.6a7.5 7.5 0 0 0 1.7-1l2.4 1 2-3.4z',
  );
  svg.append(path);
  return svg;
}

/** Marks the logo as "translated" — the icon itself never changes (doc/04 §4.3), only this badge. */
function checkIcon(doc: Document, size = 11): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '3');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const path = doc.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M5 13l4 4L19 7');
  svg.append(path);
  return svg;
}

/** A speaker, for the read-aloud shortcut; a second mark crossing it out while reading (stop). */
function speakerIcon(doc: Document, speaking: boolean, size = 16): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const cone = doc.createElementNS(SVG_NS, 'path');
  cone.setAttribute('d', 'M4 9v6h4l5 5V4L8 9H4z');
  cone.setAttribute('fill', 'currentColor');
  cone.setAttribute('stroke', 'none');
  svg.append(cone);
  if (speaking) {
    const stop = doc.createElementNS(SVG_NS, 'path');
    stop.setAttribute('d', 'M15.5 9.5l5 5m0-5l-5 5');
    svg.append(stop);
  } else {
    const wave = doc.createElementNS(SVG_NS, 'path');
    wave.setAttribute('d', 'M16.5 8.5a5 5 0 0 1 0 7');
    svg.append(wave);
  }
  return svg;
}

const STYLE = `
:host { all: initial; }
.fab {
  --accent: #2f6f5e; --accent-hover: #285f50;
  position: fixed; z-index: 2147483645; right: 8px; display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
  font: 14px/1.4 system-ui, "Microsoft YaHei", sans-serif; touch-action: none;
}
.fab[dir="rtl"] { right: auto; left: 8px; align-items: flex-start; }
button { font: inherit; cursor: pointer; border: 0; -webkit-tap-highlight-color: transparent; }
.ball {
  position: relative; width: 48px; height: 48px; border-radius: 50%; display: grid; place-items: center; padding: 0;
  background: var(--accent); color: #fff; box-shadow: 0 4px 14px rgb(0 0 0 / 28%); opacity: 0.9; touch-action: none;
  transition: opacity 0.15s ease;
}
.ball:active { background: var(--accent-hover); }
.fab:hover .ball, .fab:focus-within .ball { opacity: 1; animation: logoPop 0.45s ease; }
@keyframes logoPop {
  0% { transform: scale(1) rotate(0deg); }
  45% { transform: scale(1.16) rotate(-8deg); }
  75% { transform: scale(1.02) rotate(4deg); }
  100% { transform: scale(1.07) rotate(0deg); }
}
.fab[data-status="done"] .ball { opacity: 1; }
.fab[data-status="translating"] .ball svg { display: none; }
.fab[data-status="translating"] .ball::after {
  content: ""; width: 22px; height: 22px; border-radius: 50%; border: 3px solid rgb(255 255 255 / 40%); border-top-color: #fff;
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
/* Translated vs. original is otherwise invisible — the logo itself never changes (doc/04 §4.3) —
   so a small checkmark sits on the ball once there is something to show the original of. */
.check {
  position: absolute; bottom: -2px; inset-inline-end: -2px; width: 18px; height: 18px; border-radius: 50%;
  display: grid; place-items: center; background: #fff; color: var(--accent); box-shadow: 0 1px 4px rgb(0 0 0 / 30%);
  transform: scale(0); transition: transform 0.15s ease;
}
.fab[data-translated="true"] .check { transform: scale(1); }
.fab[data-status="translating"] .check { transform: scale(0); }
/* One pill holding both buttons, not two separate circles — a thin divider is the only seam. */
.tools {
  display: flex; flex-direction: column; width: 36px; border-radius: 18px; overflow: hidden;
  background: #fff; box-shadow: 0 2px 8px rgb(0 0 0 / 22%);
  opacity: 0; transform: scale(0.7); pointer-events: none; transition: opacity 0.15s ease, transform 0.15s ease;
}
/* A mouse reveals it on hover; a touch screen has no hover, so it stays as it always was: visible. */
.fab:hover .tools, .fab:focus-within .tools, .fab[data-open="true"] .tools, .fab[data-coarse="true"] .tools {
  opacity: 0.9; transform: scale(1); pointer-events: auto;
}
.tools:hover, .tools:focus-within { opacity: 1 !important; }
.gear, .quick-read {
  width: 36px; height: 36px; display: grid; place-items: center; padding: 0; background: none; color: #1f2937;
}
.gear:hover, .gear:active, .quick-read:hover, .quick-read:active { background: rgb(0 0 0 / 6%); }
.quick-read { border-top: 1px solid rgb(0 0 0 / 10%); }
.quick-read[data-speaking="true"] { background: var(--accent); color: #fff; }
.quick-read[data-speaking="true"]:hover, .quick-read[data-speaking="true"]:active { background: var(--accent-hover); }
.panel {
  box-sizing: border-box; width: 240px; padding: 6px 0; border-radius: 12px;
  background: rgba(28, 28, 28, 0.94); color: #fff; box-shadow: 0 8px 28px rgb(0 0 0 / 45%);
}
.row { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 40px; padding: 0 16px; width: 100%; box-sizing: border-box; background: none; color: inherit; text-align: start; }
.row:hover { background: rgb(255 255 255 / 10%); }
.switch { position: relative; width: 36px; height: 20px; flex: none; border-radius: 10px; background: rgb(255 255 255 / 30%); }
.switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform 0.15s; }
[aria-checked="true"] > .switch { background: var(--accent); }
[aria-checked="true"] > .switch::after { transform: translateX(16px); }
[dir="rtl"] [aria-checked="true"] > .switch::after { transform: translateX(-16px); }
[hidden] { display: none !important; }
`;

const clampTop = (top: number) => Math.min(MAX_TOP, Math.max(MIN_TOP, top));

export function createFloatingButton(doc: Document, deps: FloatingDeps) {
  let settings = deps.settings;
  let uiLang = resolveUiLang(settings.uiLang);
  let t: Translator = createTranslator(uiLang);
  let top = clampTop(deps.top ?? DEFAULT_TOP);
  let state: FloatingState = { status: 'idle', translated: 0, speaking: false, displayMode: settings.displayMode, autoTranslateHere: false };
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
  /** A row in the panel: a label, a switch knob if it toggles something, and the click handler. */
  const row = (onClick: () => void, withSwitch: boolean) => {
    const r = button('row');
    r.setAttribute('role', withSwitch ? 'menuitemcheckbox' : 'menuitem');
    const label = doc.createElement('span');
    r.append(label);
    let knob: HTMLElement | undefined;
    if (withSwitch) {
      knob = el('span', 'switch');
      r.append(knob);
    }
    r.addEventListener('click', onClick);
    return { r, label, knob };
  };

  const fab = el('div', 'fab');
  const panel = el('div', 'panel');
  panel.setAttribute('role', 'menu');
  const read = row(() => {
    deps.actions.toggleRead();
  }, true);
  const mode = row(() => {
    deps.actions.toggleMode();
  }, true);
  const lookup = row(() => {
    deps.actions.toggleSelectionLookup();
  }, true);
  const autoSite = row(() => {
    deps.actions.toggleAutoTranslateSite();
  }, true);
  const hide = row(() => dispose(), false);
  panel.append(read.r, mode.r, lookup.r, autoSite.r, hide.r);
  panel.hidden = true;

  const ball = button('ball');
  ball.append(brandIcon(doc, 26));
  const check = el('span', 'check');
  check.append(checkIcon(doc));
  ball.append(check);
  const gear = button('gear');
  gear.append(gearIcon(doc));
  // Read-aloud is used often enough to deserve its own shortcut, under the gear, instead of
  // always needing the panel open first. One pill holds both — not two separate circles.
  const quickRead = button('quick-read');
  const tools = el('div', 'tools');
  tools.append(gear, quickRead);
  fab.append(panel, ball, tools);
  shadow.append(style, fab);

  // On a mouse the gear only appears on hover; on a touch screen there is no hover, so it must
  // stay visible the way the old "more" button always was, or it would be unreachable.
  fab.dataset['coarse'] = String(doc.defaultView?.matchMedia?.('(pointer: coarse)').matches === true);

  function place() {
    fab.style.top = `${Math.round(top * 100)}vh`;
  }

  function setOpen(next: boolean) {
    open = next;
    render();
  }

  function render() {
    fab.dataset['status'] = state.status;
    fab.dataset['open'] = String(open);
    fab.dir = RTL_LANGUAGES.has(uiLang) ? 'rtl' : 'ltr';
    const translated = state.status === 'done' || state.status === 'translating' || state.translated > 0;
    fab.dataset['translated'] = String(translated);
    const label = translated ? t('action.restore') : t('action.translate');
    ball.setAttribute('aria-label', label);
    ball.title = label;
    gear.setAttribute('aria-label', t('float.more'));
    gear.setAttribute('aria-expanded', String(open));
    panel.hidden = !open;
    read.r.hidden = state.translated === 0;
    read.label.textContent = t('tts.read');
    read.r.setAttribute('aria-checked', String(state.speaking));
    quickRead.hidden = state.translated === 0;
    quickRead.replaceChildren(speakerIcon(doc, state.speaking));
    quickRead.dataset['speaking'] = String(state.speaking);
    const readLabel = state.speaking ? t('tts.stop') : t('tts.read');
    quickRead.setAttribute('aria-label', readLabel);
    quickRead.title = readLabel;
    mode.label.textContent = t('display.translation');
    mode.r.setAttribute('aria-checked', String(state.displayMode === 'translation'));
    lookup.label.textContent = t('section.selection');
    lookup.r.setAttribute('aria-checked', String(settings.selectionLookup));
    autoSite.label.textContent = t('float.autoSite');
    autoSite.r.setAttribute('aria-checked', String(state.autoTranslateHere));
    hide.label.textContent = t('float.hide');
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
    // Otherwise the button keeps browser focus after the click, :focus-within stays true, and the
    // gear it reveals is stuck showing until something else on the page is clicked — reported after
    // tapping the logo and then moving the mouse away, which should have hidden it right away.
    ball.blur();
  });

  gear.addEventListener('click', () => setOpen(!open));
  quickRead.addEventListener('click', () => {
    deps.actions.toggleRead();
    quickRead.blur();
  });

  // Tapping anywhere else folds the panel away.
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
