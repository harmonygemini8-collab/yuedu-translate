// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { applyStyle, buildStyle, removeAllTranslations, removeTranslation, renderTranslation } from '../src/content/renderer';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../src/shared/settings';

const done = (text: string) => ({ kind: 'done' as const, text, lang: 'zh-CN' });

describe('display mode', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-yilin-mode');
    document.body.innerHTML = '<p id="p">Hello world</p>';
  });

  it('defaults to bilingual and reads back only the two known modes', () => {
    expect(DEFAULT_SETTINGS.displayMode).toBe('bilingual');
    expect(sanitizeSettings({ displayMode: 'translation' }).displayMode).toBe('translation');
    expect(sanitizeSettings({ displayMode: 'nonsense' }).displayMode).toBe('bilingual');
  });

  it('marks the page only in translation mode', () => {
    applyStyle(document, { ...DEFAULT_SETTINGS, displayMode: 'translation' });
    expect(document.documentElement.getAttribute('data-yilin-mode')).toBe('translation');
    applyStyle(document, { ...DEFAULT_SETTINGS, displayMode: 'bilingual' });
    expect(document.documentElement.hasAttribute('data-yilin-mode')).toBe(false);
  });

  it('collapses the original only once its translation is done', () => {
    const p = document.getElementById('p')!;
    renderTranslation(p, { kind: 'loading', label: '…', lang: 'zh-CN' }, 'y1');
    expect(p.hasAttribute('data-yilin-host')).toBe(false);
    renderTranslation(p, done('你好，世界'), 'y1');
    expect(p.getAttribute('data-yilin-host')).toBe('done');
    renderTranslation(p, { kind: 'error', message: 'x', retryLabel: 'r', lang: 'zh-CN' }, 'y1');
    expect(p.hasAttribute('data-yilin-host')).toBe(false);
    renderTranslation(p, done('你好，世界'), 'y1');
    removeTranslation(p);
    expect(p.hasAttribute('data-yilin-host')).toBe(false);
  });

  it('cleans up everything on restore', () => {
    const p = document.getElementById('p')!;
    applyStyle(document, { ...DEFAULT_SETTINGS, displayMode: 'translation' });
    renderTranslation(p, done('你好，世界'), 'y1');
    removeAllTranslations(document);
    expect(p.hasAttribute('data-yilin-host')).toBe(false);
    expect(document.documentElement.hasAttribute('data-yilin-mode')).toBe(false);
  });

  it('scales the translation by the font setting in translation mode', () => {
    expect(buildStyle({ ...DEFAULT_SETTINGS, fontScale: 1.2 })).toContain('calc(var(--yilin-fs, 1rem) * 1.2)');
  });
});
