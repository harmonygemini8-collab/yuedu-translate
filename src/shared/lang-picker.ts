/**
 * Searchable language picker. With 44 target languages a plain <select> is a long scroll,
 * so the real <select> stays in the DOM (it holds the value, and `syncAvailability` keeps
 * disabling options on it) and this draws a button plus a searchable, grouped panel over it.
 *
 * Language names come from `Intl.DisplayNames` in the current UI language, so a new language
 * costs no translation work: only its own name in `TARGET_LANGUAGES`.
 */

import type { MessageKey, Translator, UiLang } from './i18n.ts';
import { LANGUAGE_GROUPS, TARGET_LANGUAGES, type TargetLang } from './settings.ts';

/** "English" in the UI language, or '' when the browser has no name for it. */
function localName(code: TargetLang, lang: UiLang): string {
  try {
    const name = new Intl.DisplayNames([lang], { type: 'language' }).of(code);
    return !name || name === code ? '' : name;
  } catch {
    return '';
  }
}

/** `英语 (English)`, or just the endonym when the UI name would add nothing. */
function label(code: TargetLang, lang: UiLang): string {
  const own = TARGET_LANGUAGES[code];
  // Naming a variant of the UI language in the UI language says it twice: a Chinese interface
  // would read "中文（中国）（简体中文）". The language's own name alone is clearer there.
  if (code.split('-')[0] === lang.split('-')[0]) return own;
  const local = localName(code, lang);
  return !local || local === own ? own : `${local} (${own})`;
}

const fold = (text: string) => text.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');

export interface LangPicker {
  /** Re-read the <select> (value, disabled options) and redraw. */
  refresh(): void;
}

export function createLangPicker(select: HTMLSelectElement, lang: UiLang, t: Translator): LangPicker {
  select.hidden = true;
  // The options page rebuilds the picker whenever the UI language changes; drop the old one.
  select.nextElementSibling?.classList.contains('lang-picker') && select.nextElementSibling.remove();
  const root = document.createElement('div');
  root.className = 'lang-picker';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'lang-picker-button';
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');
  const panel = document.createElement('div');
  panel.className = 'lang-picker-panel';
  panel.hidden = true;
  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'lang-picker-search';
  search.autocomplete = 'off';
  search.placeholder = t('lang.search');
  const list = document.createElement('div');
  list.className = 'lang-picker-list';
  list.setAttribute('role', 'listbox');
  const empty = document.createElement('p');
  empty.className = 'lang-picker-empty';
  empty.textContent = t('lang.noMatch');
  empty.hidden = true;
  panel.append(search, list, empty);
  root.append(button, panel);
  select.after(root);

  /** Which option the keyboard is on; -1 while nothing is highlighted. */
  let active = -1;
  let rows: HTMLButtonElement[] = [];

  const disabledIn = (code: TargetLang) =>
    [...select.options].find((o) => o.value === code)?.disabled ?? false;

  const choose = (code: TargetLang) => {
    select.value = code;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    close();
    paintButton();
  };

  function paintButton() {
    const code = select.value as TargetLang;
    button.textContent = label(code, lang);
    button.setAttribute('aria-label', `${t('label.targetLang')}: ${button.textContent}`);
  }

  function highlight(index: number) {
    rows[active]?.classList.remove('active');
    active = index;
    const row = rows[active];
    if (!row) return;
    row.classList.add('active');
    // Optional: jsdom (and very old engines) have no scrollIntoView, and nothing depends on it.
    row.scrollIntoView?.({ block: 'nearest' });
  }

  function paintList() {
    const query = fold(search.value.trim());
    list.replaceChildren();
    rows = [];
    for (const group of LANGUAGE_GROUPS) {
      const matches = group.langs.filter((code) => {
        if (!query) return true;
        return [label(code, lang), TARGET_LANGUAGES[code], code].some((text) => fold(text).includes(query));
      });
      if (!matches.length) continue;
      const heading = document.createElement('p');
      heading.className = 'lang-picker-group';
      heading.textContent = t(`langGroup.${group.id}` as MessageKey);
      list.append(heading);
      for (const code of matches) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'lang-picker-option';
        row.setAttribute('role', 'option');
        row.textContent = label(code, lang);
        row.dataset.code = code;
        // An engine that cannot produce this language: shown, but greyed out and unselectable.
        if (disabledIn(code)) row.disabled = true;
        else row.addEventListener('click', () => choose(code));
        if (code === select.value) row.setAttribute('aria-selected', 'true');
        list.append(row);
        if (!row.disabled) rows.push(row);
      }
    }
    empty.hidden = rows.length > 0 || list.childElementCount > 0;
    highlight(rows.length ? 0 : -1);
  }

  function open() {
    panel.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    panel.classList.remove('lang-picker-panel--above');
    const rect = button.getBoundingClientRect();
    panel.style.maxHeight = `${Math.min(280, window.innerHeight - rect.bottom - 8)}px`;
    search.value = '';
    paintList();
    search.focus();
  }

  function close() {
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  }

  button.addEventListener('click', () => (panel.hidden ? open() : close()));
  search.addEventListener('input', paintList);
  // Typing filters, the arrows walk the result, Enter takes it, Escape gives up.
  panel.addEventListener('keydown', (event) => {
    const key = (event as KeyboardEvent).key;
    if (key === 'Escape') [close(), button.focus()];
    else if (key === 'ArrowDown') highlight(Math.min(active + 1, rows.length - 1));
    else if (key === 'ArrowUp') highlight(Math.max(active - 1, 0));
    else if (key === 'Enter' && rows[active]) choose(rows[active]!.dataset.code as TargetLang);
    else return;
    event.preventDefault();
  });
  document.addEventListener('click', (event) => {
    if (!panel.hidden && !root.contains(event.target as Node)) close();
  });

  paintButton();
  return {
    refresh() {
      paintButton();
      if (!panel.hidden) paintList();
    },
  };
}
