import { beforeEach, describe, expect, it } from 'vitest';
import { CATALOGS, UI_LANGUAGES, applyTranslations, createTranslator, resolveUiLang, type UiLang } from '../src/shared/i18n';
import { shouldTranslate } from '../src/content/extractor';
import { renderTranslation, buildStyle } from '../src/content/renderer';
import { DEFAULT_SETTINGS, ENGINE_LANGUAGES, TARGET_LANGUAGES, engineSupports, sanitizeSettings } from '../src/shared/settings';

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('UI translations', () => {
  it('offers every UI language with a complete catalog and matching placeholders', () => {
    const source = CATALOGS['zh-CN'];
    for (const lang of Object.keys(UI_LANGUAGES) as UiLang[]) {
      const catalog = CATALOGS[lang];
      for (const key of Object.keys(source) as (keyof typeof source)[]) {
        expect(catalog[key], `${lang}:${key}`).toBeTruthy();
        expect(placeholders(catalog[key]), `${lang}:${key}`).toEqual(placeholders(source[key]));
      }
    }
  });

  it('follows the browser language when set to auto', () => {
    expect(resolveUiLang('auto', 'zh-CN')).toBe('zh-CN');
    expect(resolveUiLang('auto', 'zh-HK')).toBe('zh-TW');
    expect(resolveUiLang('auto', 'zh-Hant-TW')).toBe('zh-TW');
    expect(resolveUiLang('auto', 'vi-VN')).toBe('vi');
    expect(resolveUiLang('auto', 'ms-MY')).toBe('ms');
    expect(resolveUiLang('auto', 'ar-SA')).toBe('ar');
    expect(resolveUiLang('auto', 'en-GB')).toBe('en');
    expect(resolveUiLang('auto', 'fr-FR')).toBe('en');
    expect(resolveUiLang('vi', 'zh-CN')).toBe('vi');
  });

  it('supports Japanese selection and browser locales (FR-09)', () => {
    expect(UI_LANGUAGES).toHaveProperty('ja', '日本語');
    for (const locale of ['ja', 'ja-JP', 'JA-jp']) expect(resolveUiLang('auto', locale)).toBe('ja');
    expect(resolveUiLang('ja', 'en-US')).toBe('ja');
    expect(sanitizeSettings({ uiLang: 'ja' }).uiLang).toBe('ja');
    expect(sanitizeSettings({ uiLang: 'ja' }).targetLang).toBe(DEFAULT_SETTINGS.targetLang);
    expect(createTranslator('ja')('count.translated', { n: 3 })).toBe('3 段落を翻訳済み');
    document.documentElement.innerHTML = '<body><button data-i18n="action.translate" data-i18n-attr="title:popup.settings"></button></body>';
    applyTranslations(document, 'ar');
    applyTranslations(document, 'ja');
    expect(document.documentElement.lang).toBe('ja');
    expect(document.documentElement.dir).toBe('ltr');
    expect(document.querySelector('button')!.textContent).toBe('翻訳');
    expect(document.querySelector('button')!.title).toBe('設定');
  });

  it('fills placeholders', () => {
    expect(createTranslator('en')('count.translated', { n: 3 })).toBe('3 translated');
    expect(createTranslator('zh-CN')('connection.ok', { cost: 0.5, budget: 10 })).toBe('已连接 · 本月费用 $0.5 / $10');
  });

  it('localises static pages and switches to right-to-left for Arabic', () => {
    document.documentElement.innerHTML = '<body><h2 data-i18n="privacy.title"></h2><button data-i18n-attr="title:popup.settings;aria-label:popup.settings"></button></body>';
    applyTranslations(document, 'ar');
    expect(document.querySelector('h2')!.textContent).toBe(CATALOGS.ar['privacy.title']);
    expect(document.querySelector('button')!.getAttribute('aria-label')).toBe(CATALOGS.ar['popup.settings']);
    expect(document.documentElement.dir).toBe('rtl');
    applyTranslations(document, 'en');
    expect(document.documentElement.dir).toBe('ltr');
    expect(document.querySelector('h2')!.textContent).toBe('Before you start');
  });

  it('stores the UI language setting safely', () => {
    expect(sanitizeSettings({}).uiLang).toBe('auto');
    expect(sanitizeSettings({ uiLang: 'ms' }).uiLang).toBe('ms');
    expect(sanitizeSettings({ uiLang: 'xx' }).uiLang).toBe('auto');
  });
});

describe('new target languages', () => {
  it('adds Vietnamese, Malay and Arabic, labelled in their own language', () => {
    expect(TARGET_LANGUAGES).toMatchObject({ vi: 'Tiếng Việt', ms: 'Bahasa Melayu', ar: 'العربية' });
    expect(sanitizeSettings({ targetLang: 'ar' }).targetLang).toBe('ar');
  });

  it('knows which engines support which languages', () => {
    for (const lang of ['vi', 'ms', 'ar'] as const) {
      expect(engineSupports('google-free', lang)).toBe(true);
      expect(engineSupports('microsoft', lang)).toBe(true);
      expect(engineSupports('openai', lang)).toBe(true);
    }
    // Every engine reaches the whole list except Cantonese on the official Google API, and the table may not drift from it.
    for (const [engine, langs] of Object.entries(ENGINE_LANGUAGES)) {
      const all = Object.keys(TARGET_LANGUAGES).filter((lang) => engine !== 'google' || lang !== 'yue');
      expect(langs, engine).toEqual(all);
    }
    expect(engineSupports('google-free', 'yue')).toBe(true);
    expect(engineSupports('google', 'yue')).toBe(false);
  });

  it('skips text that is already in the target language', () => {
    expect(shouldTranslate('مرحبا بكم في موقعنا الجديد', 'ar')).toBe(false);
    expect(shouldTranslate('Welcome to our new site', 'ar')).toBe(true);
    expect(shouldTranslate('Chào mừng bạn đến với trang web của chúng tôi', 'vi')).toBe(false);
    expect(shouldTranslate('Welcome to our new website', 'vi')).toBe(true);
    // Malay uses plain Latin letters and cannot be told apart from English reliably.
    expect(shouldTranslate('Selamat datang ke laman web kami', 'ms')).toBe(true);
  });
});

describe('right-to-left rendering', () => {
  beforeEach(() => {
    document.body.innerHTML = '<p>Hello world</p>';
  });

  it('marks Arabic translations as right-to-left and others as left-to-right', () => {
    const p = document.querySelector('p')!;
    renderTranslation(p, { kind: 'done', text: 'مرحبا بالعالم', lang: 'ar' }, 'y1');
    const node = p.querySelector<HTMLElement>('[data-yilin="translation"]')!;
    expect(node.dir).toBe('rtl');
    expect(node.lang).toBe('ar');
    renderTranslation(p, { kind: 'done', text: 'Xin chào thế giới', lang: 'vi' }, 'y1');
    expect(node.dir).toBe('ltr');
  });

  it('puts the marker line on the reading-start side', () => {
    expect(buildStyle(DEFAULT_SETTINGS)).toContain('border-inline-start: 2px solid currentColor');
    expect(buildStyle(DEFAULT_SETTINGS)).not.toContain('border-left: 2px');
  });

  it('keeps an Arabic translation next to its marker line even when the page forces left alignment', () => {
    document.head.innerHTML = `<style>${buildStyle(DEFAULT_SETTINGS)}</style>`;
    document.body.innerHTML = '<p style="text-align: left">Hello world</p>';
    const p = document.querySelector('p')!;
    renderTranslation(p, { kind: 'done', text: 'مرحبا بالعالم', lang: 'ar' }, 'y1');
    const node = p.querySelector<HTMLElement>('[data-yilin="translation"]')!;
    expect(getComputedStyle(node).textAlign).toBe('start');
    renderTranslation(p, { kind: 'done', text: '你好，世界', lang: 'zh-CN' }, 'y1');
    expect(getComputedStyle(node).textAlign).not.toBe('start');
  });

  it('shows loading and error notes in the UI language', () => {
    const p = document.querySelector('p')!;
    renderTranslation(p, { kind: 'error', message: CATALOGS.vi['pageError.NETWORK'], retryLabel: CATALOGS.vi['page.retry'], lang: 'vi' }, 'y1');
    expect(p.querySelector('[data-yilin-retry]')!.textContent).toBe('Thử lại');
  });
});
