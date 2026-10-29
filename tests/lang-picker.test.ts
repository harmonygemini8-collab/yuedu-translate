import { beforeEach, describe, expect, it } from 'vitest';
import { createLangPicker } from '../src/shared/lang-picker';
import { createTranslator } from '../src/shared/i18n';
import { ENGINE_LANGUAGES, LANGUAGE_GROUPS, TARGET_LANGUAGES, type TargetLang } from '../src/shared/settings';

const t = createTranslator('zh-CN');

function mount(selected: TargetLang = 'zh-CN', disabled: TargetLang[] = []) {
  document.body.innerHTML = '<select id="target"></select>';
  const select = document.getElementById('target') as HTMLSelectElement;
  for (const [value, label] of Object.entries(TARGET_LANGUAGES)) {
    const option = new Option(label, value);
    option.disabled = disabled.includes(value as TargetLang);
    select.append(option);
  }
  select.value = selected;
  const picker = createLangPicker(select, 'zh-CN', t);
  const button = document.querySelector<HTMLButtonElement>('.lang-picker-button')!;
  const search = document.querySelector<HTMLInputElement>('.lang-picker-search')!;
  const rows = () => [...document.querySelectorAll<HTMLButtonElement>('.lang-picker-option')];
  return { select, picker, button, search, rows };
}

describe('language list', () => {
  it('covers every language exactly once across the region groups', () => {
    const grouped = LANGUAGE_GROUPS.flatMap((group) => group.langs);
    expect([...grouped].sort()).toEqual(Object.keys(TARGET_LANGUAGES).sort());
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  it('keeps every engine list inside the language table', () => {
    for (const langs of Object.values(ENGINE_LANGUAGES)) {
      for (const lang of langs) expect(TARGET_LANGUAGES[lang]).toBeTruthy();
    }
  });
});

describe('language picker', () => {
  beforeEach(() => document.body.replaceChildren());

  it('hides the select and shows the current language in the UI language', () => {
    const { select, button } = mount('ja');
    expect(select.hidden).toBe(true);
    expect(button.textContent).toBe('日语 (日本語)');
  });

  it('does not name a variant of the UI language twice', () => {
    expect(mount('zh-CN').button.textContent).toBe('简体中文');
    document.body.replaceChildren();
    expect(mount('zh-TW').button.textContent).toBe('繁體中文');
  });

  it('opens on click and lists every language under its region', () => {
    const { button, rows } = mount();
    button.click();
    expect(rows()).toHaveLength(Object.keys(TARGET_LANGUAGES).length);
    expect(document.querySelectorAll('.lang-picker-group')).toHaveLength(LANGUAGE_GROUPS.length);
  });

  it('searches by UI name, by the language\'s own name and by code', () => {
    const { button, search, rows } = mount();
    button.click();
    const find = (query: string) => {
      search.value = query;
      search.dispatchEvent(new Event('input'));
      return rows().map((row) => row.dataset.code);
    };
    expect(find('德语')).toEqual(['de']);
    expect(find('Français')).toEqual(['fr']);
    expect(find('pt')).toEqual(['pt', 'pt-BR']);
    expect(find('português')).toEqual(['pt', 'pt-BR']);
    expect(find('zzz')).toEqual([]);
    expect(document.querySelector<HTMLElement>('.lang-picker-empty')!.hidden).toBe(false);
  });

  it('writes the choice back to the select and fires change', () => {
    const { select, button, rows } = mount();
    let changes = 0;
    select.addEventListener('change', () => changes++);
    button.click();
    rows().find((row) => row.dataset.code === 'tr')!.click();
    expect(select.value).toBe('tr');
    expect(changes).toBe(1);
    expect(button.textContent).toBe('土耳其语 (Türkçe)');
    expect(document.querySelector<HTMLElement>('.lang-picker-panel')!.hidden).toBe(true);
  });

  it('greys out languages the chosen engine cannot produce, and refuses to pick them', () => {
    // No engine on offer today is missing a language, so the disabled state is driven directly.
    const { select, button, rows } = mount('zh-CN', ['th', 'ms']);
    button.click();
    const thai = rows().find((row) => row.dataset.code === 'th')!;
    expect(thai.disabled).toBe(true);
    thai.click();
    expect(select.value).toBe('zh-CN');
  });
});
