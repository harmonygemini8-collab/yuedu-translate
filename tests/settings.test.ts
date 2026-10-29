import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, isAutoTranslateSite, isSiteDisabled, migrateSettings, normalizeHost, pageIsInTargetLanguage, sanitizeSettings, siteOrigins, autoScriptMatches, ALL_SITES_ORIGINS } from '../src/shared/settings';
import { isRestrictedUrl } from '../src/shared/messages';
import { buildStyle } from '../src/content/renderer';

describe('sanitizeSettings', () => {
  it('falls back to defaults for missing or malformed values', () => {
    expect(sanitizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings({ targetLang: 'xx', fontScale: 'big', gap: -5, privacyAcknowledged: 'yes' })).toEqual({
      ...DEFAULT_SETTINGS,
      gap: 0,
    });
  });

  it('clamps numbers and rejects colors that could inject CSS', () => {
    const s = sanitizeSettings({ fontScale: 9, gap: 100, color: 'red; } body { display:none' });
    expect(s.fontScale).toBe(1.3);
    expect(s.gap).toBe(24);
    expect(s.color).toBe('');
    expect(buildStyle(s)).not.toContain('display:none');
    expect(sanitizeSettings({ color: '#A0B1C2' }).color).toBe('#a0b1c2');
  });

  it('normalizes disabled sites', () => {
    const s = sanitizeSettings({ disabledSites: ['https://www.Example.com/path', 'example.com', '', 'not a host', 42] });
    expect(s.disabledSites).toEqual(['example.com']);
  });
});

describe('translation style', () => {
  it('matches the original text by default (inherited font and colour, no fading) and keeps the left marker line', () => {
    const css = buildStyle(DEFAULT_SETTINGS);
    expect(css).toContain('font: inherit !important;');
    expect(css).toContain('font-size: inherit !important;');
    expect(css).toContain('color: inherit !important;');
    expect(css).toContain('opacity: 1 !important;');
    expect(css).toContain('border-inline-start: 2px solid currentColor !important;');
    // Only the default translation rule (the first block); compact UI text in whole-page mode is styled separately.
    expect(css.split('}')[0]).not.toMatch(/font-weight: normal|line-height: 1\.6|opacity: 0\.8/);
  });

  it('still honours explicit customisation', () => {
    const css = buildStyle({ ...DEFAULT_SETTINGS, fontScale: 0.9, color: '#336699', showBorder: false });
    expect(css).toContain('font-size: 0.9em !important;');
    expect(css).toContain('color: #336699 !important;');
    expect(css).not.toContain('border-inline-start: 2px');
  });

  it('migrates v1 style values and keeps everything else', () => {
    const v1 = { fontScale: 0.95, showBorder: true, color: '', engine: 'openai', gap: 8, privacyAcknowledged: true };
    const { values, changed } = migrateSettings(v1);
    expect(changed).toBe(true);
    expect(sanitizeSettings(values)).toMatchObject({ fontScale: 1, showBorder: true, color: '', engine: 'openai', gap: 8, privacyAcknowledged: true });
  });

  it('turns the marker line back on for installs already migrated to v2', () => {
    const v2 = { settingsVersion: 2, fontScale: 1, showBorder: false, color: '', gap: 6 };
    const { values, changed } = migrateSettings(v2);
    expect(changed).toBe(true);
    expect(sanitizeSettings(values)).toMatchObject({ fontScale: 1, showBorder: true, gap: 6 });
  });

  it('leaves later customisation alone', () => {
    const { values } = migrateSettings({ fontScale: 0.95 });
    const later = migrateSettings({ ...values, fontScale: 1.2, showBorder: false });
    expect(later.changed).toBe(false);
    expect(sanitizeSettings(later.values)).toMatchObject({ fontScale: 1.2, showBorder: false });
  });
});

describe('site helpers', () => {
  it('matches disabled sites including subdomains', () => {
    const s = { ...DEFAULT_SETTINGS, disabledSites: ['example.com'] };
    expect(isSiteDisabled(s, 'docs.example.com')).toBe(true);
    expect(isSiteDisabled(s, 'www.example.com')).toBe(true);
    expect(isSiteDisabled(s, 'notexample.com')).toBe(false);
  });

  it('parses hosts', () => {
    expect(normalizeHost('sub.example.co.uk')).toBe('sub.example.co.uk');
    expect(normalizeHost('javascript:alert(1)')).toBeNull();
  });

  it('matches auto-translate sites and asks for their subdomains too', () => {
    const s = { ...DEFAULT_SETTINGS, autoTranslateSites: ['example.com'] };
    expect(isAutoTranslateSite(s, 'news.example.com')).toBe(true);
    expect(isAutoTranslateSite(s, 'other.com')).toBe(false);
    expect(siteOrigins('example.com')).toEqual(['*://example.com/*', '*://*.example.com/*']);
    // With the all-sites grant the script is on every page, so lookup works before anything is translated.
    expect(autoScriptMatches(true, ['example.com'])).toEqual(ALL_SITES_ORIGINS);
    expect(autoScriptMatches(false, ['example.com'])).toEqual(['*://example.com/*', '*://*.example.com/*']);
    expect(autoScriptMatches(false, [])).toEqual([]);
    expect(DEFAULT_SETTINGS.debugReading).toBe(false);
    expect(sanitizeSettings({ debugReading: true }).debugReading).toBe(true);
    expect(sanitizeSettings({ debugReading: 'yes' }).debugReading).toBe(false);
  });

  it('auto-translates only when the declared page language differs from the target', () => {
    expect(pageIsInTargetLanguage('zh-CN', 'zh-CN')).toBe(true);
    // Our engines cannot convert between Chinese variants, so zh-TW counts as already Chinese.
    expect(pageIsInTargetLanguage('zh-TW', 'zh-CN')).toBe(true);
    expect(pageIsInTargetLanguage('EN-us', 'zh-CN')).toBe(false);
    expect(pageIsInTargetLanguage('vi', 'vi')).toBe(true);
    // Unknown or missing: the extractor decides from the text instead.
    expect(pageIsInTargetLanguage('', 'zh-CN')).toBe(false);
    expect(pageIsInTargetLanguage(null, 'zh-CN')).toBe(false);
  });

  it('moves users off a service that no longer exists', () => {
    // DeepL was removed (ADR-24); a stored choice must land on the default, not on nothing.
    expect(sanitizeSettings({ engine: 'deepl' }).engine).toBe(DEFAULT_SETTINGS.engine);
    expect(sanitizeSettings({ engine: 'microsoft' }).engine).toBe('microsoft');
  });

  it('keeps the selection lookup switch, defaulting to on', () => {
    expect(sanitizeSettings({}).selectionLookup).toBe(true);
    expect(sanitizeSettings({ selectionLookup: false }).selectionLookup).toBe(false);
    expect(sanitizeSettings({ selectionLookup: 'yes' }).selectionLookup).toBe(true);
  });

  it('flags pages the extension cannot or should not run on', () => {
    for (const url of [undefined, 'chrome://settings', 'https://chromewebstore.google.com/detail/x', 'about:blank', 'https://a.com/file.pdf']) {
      expect(isRestrictedUrl(url)).toBe(true);
    }
    expect(isRestrictedUrl('https://developer.mozilla.org/en-US/')).toBe(false);
    expect(isRestrictedUrl('http://127.0.0.1:4173/')).toBe(false);
  });
});
