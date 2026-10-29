import type { EngineChoice } from './settings';

/**
 * A listbox that shows each service's logo, standing in for the native `<select>`.
 *
 * A native `<option>` cannot hold an image, so the logos need custom markup. Rather than replace
 * the select everywhere, the select stays in the DOM as the single source of truth — it keeps
 * `.value`, the `change` event, `option.disabled` and, on the options page, its place in the form.
 * This widget only mirrors it and writes back, so the pages around it did not have to change.
 */

/** Logo per engine, by file name under `icons/engines/`. Several engines share one mark. */
const LOGOS: Record<string, string> = {
  'google-free': 'google',
  google: 'google',
  microsoft: 'microsoft',
  'qwen-free': 'qwen',
  'glm-free': 'glm',
  'hunyuan-mt': 'hunyuan',
  openai: 'openai',
  'openai-premium': 'openai',
};

/**
 * Marks drawn in one colour. They ship as `fill="currentColor"`, which an `<img>` resolves to
 * black because the image is its own document and inherits nothing — invisible on a dark
 * background. These are painted as a mask over the text colour instead, so they follow the theme.
 */
const MONO = new Set(['openai']);

const STYLE_ID = 'yilin-engine-picker-style';

const CSS = `
.yl-picker { position: relative; display: block; width: 100%; }
.yl-picker__button {
  display: flex; align-items: center; gap: 8px; width: 100%; box-sizing: border-box;
  padding: 5px 28px 5px 8px; font: inherit; color: inherit; text-align: start; cursor: pointer;
  background: Field; border: 1px solid var(--border, #d9dde3); border-radius: 6px;
}
.yl-picker__button::after {
  content: ""; position: absolute; inset-inline-end: 10px; top: 50%; width: 6px; height: 6px;
  margin-top: -4px; border: solid currentColor; border-width: 0 1.5px 1.5px 0;
  transform: rotate(45deg); opacity: .5; pointer-events: none;
}
.yl-picker__button:focus-visible { outline: 2px solid var(--accent, #2f6f5e); outline-offset: 1px; }
.yl-picker__label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.yl-picker__logo { flex: none; width: 16px; height: 16px; object-fit: contain; }
.yl-picker__logo--mono {
  background: currentColor;
  -webkit-mask: var(--yl-mask) center / contain no-repeat;
  mask: var(--yl-mask) center / contain no-repeat;
}
.yl-picker__list {
  position: absolute; z-index: 20; inset-inline: 0; top: calc(100% + 4px); max-height: 260px;
  overflow-y: auto; margin: 0; padding: 4px; list-style: none; background: Canvas;
  border: 1px solid var(--border, #d9dde3); border-radius: 8px;
  box-shadow: 0 8px 24px rgb(0 0 0 / .14);
}
.yl-picker__list[hidden] { display: none; }
.yl-picker__group { padding: 6px 8px 2px; font-size: 11px; opacity: .6; }
.yl-picker__option {
  display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 5px; cursor: pointer;
}
.yl-picker__option[aria-selected="true"] { font-weight: 600; }
.yl-picker__option[data-active="true"] { background: color-mix(in srgb, currentColor 10%, transparent); }
.yl-picker__option[aria-disabled="true"] { opacity: .4; cursor: default; }
`;

function ensureStyle(doc: Document) {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  doc.head.append(style);
}

function logoFor(doc: Document, value: string): HTMLElement | null {
  const file = LOGOS[value];
  if (!file) return null;
  const src = `icons/engines/${file}.svg`;
  if (MONO.has(file)) {
    const span = doc.createElement('span');
    span.className = 'yl-picker__logo yl-picker__logo--mono';
    span.style.setProperty('--yl-mask', `url("${src}")`);
    return span;
  }
  const img = doc.createElement('img');
  img.className = 'yl-picker__logo';
  img.src = src;
  img.alt = '';
  return img;
}

export interface EnginePicker {
  /** Re-read the select: its value, its options and which of them are disabled. */
  refresh(): void;
}

export function enhanceEngineSelect(select: HTMLSelectElement): EnginePicker {
  const doc = select.ownerDocument;
  ensureStyle(doc);

  const wrap = doc.createElement('div');
  wrap.className = 'yl-picker';
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'yl-picker__button';
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');
  const list = doc.createElement('ul');
  list.className = 'yl-picker__list';
  list.setAttribute('role', 'listbox');
  list.hidden = true;
  wrap.append(button, list);

  select.before(wrap);
  // The select keeps the state but must not be reachable twice: the widget is the only stop.
  select.hidden = true;
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');
  // Both pages wrap the select in a <label> whose first span is the field name. Hiding the
  // select detaches it from that label, so the name is copied onto the widget instead.
  const fieldName = select.closest('label')?.querySelector('span')?.textContent?.trim();
  if (fieldName) button.setAttribute('aria-label', fieldName);

  let options: HTMLOptionElement[] = [];
  let active = -1;

  const open = () => !list.hidden;

  function renderButton() {
    const current = select.selectedOptions[0];
    button.replaceChildren();
    const logo = current ? logoFor(doc, current.value) : null;
    if (logo) button.append(logo);
    const label = doc.createElement('span');
    label.className = 'yl-picker__label';
    label.textContent = current?.textContent ?? '';
    button.append(label);
  }

  function renderList() {
    list.replaceChildren();
    options = [];
    for (const group of select.children) {
      if (group instanceof HTMLOptGroupElement) {
        const heading = doc.createElement('li');
        heading.className = 'yl-picker__group';
        heading.setAttribute('role', 'presentation');
        heading.textContent = group.label;
        list.append(heading);
      }
      const children = group instanceof HTMLOptGroupElement ? group.children : [group];
      for (const child of children) {
        if (!(child instanceof HTMLOptionElement)) continue;
        options.push(child);
        const item = doc.createElement('li');
        item.className = 'yl-picker__option';
        item.setAttribute('role', 'option');
        item.dataset.value = child.value;
        item.setAttribute('aria-selected', String(child.value === select.value));
        if (child.disabled) item.setAttribute('aria-disabled', 'true');
        const logo = logoFor(doc, child.value);
        if (logo) item.append(logo);
        const label = doc.createElement('span');
        label.className = 'yl-picker__label';
        label.textContent = child.textContent ?? '';
        item.append(label);
        list.append(item);
      }
    }
  }

  const items = () => [...list.querySelectorAll<HTMLElement>('.yl-picker__option')];

  function setActive(index: number) {
    const all = items();
    active = Math.max(0, Math.min(index, all.length - 1));
    all.forEach((el, i) => (el.dataset.active = String(i === active)));
    all[active]?.scrollIntoView({ block: 'nearest' });
  }

  function choose(index: number) {
    const option = options[index];
    if (!option || option.disabled) return;
    select.value = option.value;
    // The pages listen on the select, so the event has to come from it, not from the widget.
    select.dispatchEvent(new Event('change', { bubbles: true }));
    close();
    renderButton();
  }

  function openList() {
    renderList();
    list.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    setActive(Math.max(0, options.findIndex((o) => o.value === select.value)));
  }

  function close() {
    list.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    button.focus();
  }

  /** Next option in `step` direction that can actually be chosen. */
  function move(step: number) {
    const total = options.length;
    for (let i = 1; i <= total; i++) {
      const next = (active + step * i + total * total) % total;
      if (!options[next]?.disabled) return setActive(next);
    }
  }

  button.addEventListener('click', () => (open() ? close() : openList()));

  button.addEventListener('keydown', (event) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
      event.preventDefault();
      if (!open()) openList();
      else if (event.key === 'Enter' || event.key === ' ') choose(active);
      else move(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Escape' && open()) {
      event.preventDefault();
      close();
    } else if ((event.key === 'Home' || event.key === 'End') && open()) {
      // Land on a row that can actually be chosen, or Enter would do nothing there.
      event.preventDefault();
      const enabled = options.flatMap((o, i) => (o.disabled ? [] : [i]));
      const target = event.key === 'Home' ? enabled[0] : enabled[enabled.length - 1];
      if (target !== undefined) setActive(target);
    }
  });

  list.addEventListener('click', (event) => {
    // Both pages wrap the field in a <label>, and a row is an <li>, which is not interactive.
    // Clicking one therefore makes the label forward activation to its first labelable
    // descendant — this button — whose handler toggles the list, reopening what choose() just
    // closed. Cancelling the default stops that forwarding; an <li> has no other default.
    event.preventDefault();
    const item = (event.target as Element).closest<HTMLElement>('.yl-picker__option');
    if (item) choose(items().indexOf(item));
  });
  list.addEventListener('mousemove', (event) => {
    const item = (event.target as Element).closest<HTMLElement>('.yl-picker__option');
    if (item) setActive(items().indexOf(item));
  });

  doc.addEventListener('pointerdown', (event) => {
    if (open() && !wrap.contains(event.target as Node)) close();
  });

  renderButton();
  return {
    refresh() {
      renderButton();
      if (open()) renderList();
    },
  };
}

export const engineLogoFile = (value: EngineChoice): string | undefined => LOGOS[value];
