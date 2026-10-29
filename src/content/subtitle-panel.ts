/**
 * The subtitle menu shared by every entry point that offers it (FR-19): the button in YouTube's
 * control bar and the badge over other sites' videos. One menu, so the two can never drift apart:
 * switch subtitle translation on and off, bilingual or translation only, the translation's colours,
 * and moving the block back under the picture.
 *
 * Every text is written with textContent; the caller puts the panel in a shadow root.
 */

import { RTL_LANGUAGES, createTranslator, resolveUiLang, type MessageKey } from '../shared/i18n';
import type { DisplayMode, Settings } from '../shared/settings';

export interface PanelDeps {
  getSettings(): Settings;
  /** Whether subtitle translation is running now. */
  isActive(): boolean;
  setActive(on: boolean): void;
  setSettings(patch: Partial<Settings>): void;
  resetPosition(): void;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export const PANEL_STYLE = `
:host { all: initial; }
.panel {
  box-sizing: border-box; width: 280px; padding: 6px 0; border-radius: 12px;
  background: rgba(28, 28, 28, 0.94); color: #fff; font: 13px/1.4 system-ui, sans-serif;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
}
.title { padding: 8px 16px 6px; font-weight: 600; font-size: 13px; opacity: 0.9; }
.row { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 40px; padding: 0 16px; }
button.row { width: 100%; border: 0; background: none; color: inherit; font: inherit; text-align: start; cursor: pointer; }
.row:hover { background: rgba(255, 255, 255, 0.1); }
.switch { position: relative; width: 36px; height: 20px; flex: none; border-radius: 10px; background: rgba(255, 255, 255, 0.3); }
.switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform 0.15s; }
[aria-checked="true"] > .switch { background: #14b8a6; }
[aria-checked="true"] > .switch::after { transform: translateX(16px); }
[dir="rtl"] [aria-checked="true"] > .switch::after { transform: translateX(-16px); }
.modes { display: flex; border: 1px solid rgba(255, 255, 255, 0.35); border-radius: 8px; overflow: hidden; }
.modes button { border: 0; padding: 4px 10px; background: none; color: inherit; font: inherit; cursor: pointer; }
.modes button[aria-pressed="true"] { background: rgba(255, 255, 255, 0.25); font-weight: 600; }
input[type="color"] { width: 36px; height: 24px; padding: 0; border: 1px solid rgba(255, 255, 255, 0.5); border-radius: 6px; background: none; cursor: pointer; }
`;

/**
 * The application icon (doc/assets/icon.svg): the brand gradient, the original in white and its
 * translation under it in yellow with the accent line. Built node by node, never from markup.
 */
export function brandIcon(doc: Document, size = 24): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.style.display = 'block';
  const node = (name: string, attrs: Record<string, string>, parent: Element = svg) => {
    const el = doc.createElementNS(SVG_NS, name);
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
    parent.append(el);
    return el;
  };
  const gradient = node('linearGradient', { id: 'yilin-yt-gradient', x1: '0', y1: '0', x2: '1', y2: '1' }, node('defs', {}));
  node('stop', { offset: '0', 'stop-color': '#14b8a6' }, gradient);
  node('stop', { offset: '1', 'stop-color': '#2563eb' }, gradient);
  node('rect', { width: '24', height: '24', rx: '5.5', fill: 'url(#yilin-yt-gradient)' });
  node('rect', { x: '4.5', y: '5.6', width: '15', height: '4.1', rx: '2.05', fill: '#fff' });
  node('rect', { x: '4.5', y: '11.2', width: '10.9', height: '2.6', rx: '1.3', fill: '#fff', 'fill-opacity': '0.8' });
  node('rect', { x: '4.5', y: '15.7', width: '1.9', height: '4.1', rx: '0.95', fill: '#fcd34d' });
  node('rect', { x: '7.9', y: '15.7', width: '11.6', height: '4.1', rx: '2.05', fill: '#fcd34d' });
  return svg;
}

/** Clicks and keys in the menu must not reach the player, which would pause the video or run a shortcut. */
export function swallowEvents(el: HTMLElement): void {
  for (const type of ['click', 'dblclick', 'pointerdown', 'pointerup', 'mousedown', 'touchstart', 'touchend', 'keydown', 'keyup', 'contextmenu']) {
    el.addEventListener(type, (event) => event.stopPropagation());
  }
}

export function buildPanel(doc: Document, deps: PanelDeps): HTMLElement {
  const settings = deps.getSettings();
  const t = (key: MessageKey) => createTranslator(resolveUiLang(settings.uiLang))(key);
  const panel = doc.createElement('div');
  panel.className = 'panel';
  panel.setAttribute('role', 'menu');
  panel.dir = RTL_LANGUAGES.has(resolveUiLang(settings.uiLang)) ? 'rtl' : 'ltr';

  const title = doc.createElement('div');
  title.className = 'title';
  title.textContent = t('yt.title');

  const toggle = doc.createElement('button');
  toggle.className = 'row';
  toggle.setAttribute('role', 'menuitemcheckbox');
  toggle.setAttribute('aria-checked', String(deps.isActive()));
  const toggleLabel = doc.createElement('span');
  toggleLabel.textContent = t('yt.toggle');
  const knob = doc.createElement('span');
  knob.className = 'switch';
  toggle.append(toggleLabel, knob);
  toggle.addEventListener('click', () => deps.setActive(!deps.isActive()));

  const modeRow = doc.createElement('div');
  modeRow.className = 'row';
  const modeLabel = doc.createElement('span');
  modeLabel.textContent = t('yt.mode');
  const modes = doc.createElement('div');
  modes.className = 'modes';
  for (const mode of ['bilingual', 'translation'] as DisplayMode[]) {
    const choice = doc.createElement('button');
    choice.dataset['mode'] = mode;
    choice.textContent = t(`display.${mode}`);
    choice.setAttribute('aria-pressed', String(settings.displayMode === mode));
    choice.addEventListener('click', () => deps.setSettings({ displayMode: mode }));
    modes.append(choice);
  }
  modeRow.append(modeLabel, modes);

  const colour = (key: 'subtitleColor' | 'subtitleBackground', label: MessageKey) => {
    const row = doc.createElement('label');
    row.className = 'row';
    const text = doc.createElement('span');
    text.textContent = t(label);
    const input = doc.createElement('input');
    input.type = 'color';
    input.dataset['setting'] = key;
    input.value = settings[key];
    // `change` fires once the picker closes; `input` would save on every step of a drag.
    input.addEventListener('change', () => deps.setSettings({ [key]: input.value }));
    row.append(text, input);
    return row;
  };

  const reset = doc.createElement('button');
  reset.className = 'row';
  reset.dataset['action'] = 'reset';
  reset.textContent = t('yt.reset');
  reset.addEventListener('click', () => deps.resetPosition());

  panel.append(title, toggle, modeRow, colour('subtitleColor', 'style.subtitleColor'), colour('subtitleBackground', 'style.subtitleBackground'), reset);
  return panel;
}
