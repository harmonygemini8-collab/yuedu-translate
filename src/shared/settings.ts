import { isUiLangSetting, type UiLangSetting } from './i18n.ts';

/**
 * Target languages, labelled in their own language so the label reads the same whatever the
 * UI language is. The picker shows the name in the UI language next to it via `Intl.DisplayNames`,
 * so adding a language costs no translation work.
 */
export const TARGET_LANGUAGES = {
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
  yue: '粵語',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
  vi: 'Tiếng Việt',
  th: 'ไทย',
  id: 'Bahasa Indonesia',
  ms: 'Bahasa Melayu',
  fil: 'Filipino',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
  it: 'Italiano',
  pt: 'Português',
  'pt-BR': 'Português (Brasil)',
  nl: 'Nederlands',
  sv: 'Svenska',
  da: 'Dansk',
  nb: 'Norsk bokmål',
  fi: 'Suomi',
  ru: 'Русский',
  uk: 'Українська',
  pl: 'Polski',
  cs: 'Čeština',
  sk: 'Slovenčina',
  sl: 'Slovenščina',
  hu: 'Magyar',
  ro: 'Română',
  bg: 'Български',
  hr: 'Hrvatski',
  el: 'Ελληνικά',
  et: 'Eesti',
  lv: 'Latviešu',
  lt: 'Lietuvių',
  ar: 'العربية',
  he: 'עברית',
  fa: 'فارسی',
  tr: 'Türkçe',
  hi: 'हिन्दी',
  bn: 'বাংলা',
  ur: 'اردو',
  ta: 'தமிழ்',
  sw: 'Kiswahili',
} as const;

export type TargetLang = keyof typeof TARGET_LANGUAGES;

/** User-facing translation service choice. */
export const ENGINE_OPTIONS = {
  'google-free': '谷歌翻译（免费）',
  microsoft: '微软翻译（免费额度）',
  'qwen-free': 'Qwen3-8B（免费）',
  'glm-free': 'GLM-4-9B（免费）',
  'hunyuan-mt': '混元翻译 MT-7B（免费）',
  google: '谷歌翻译（官方 API）',
  openai: 'OpenAI（VIP）',
  'openai-premium': 'OpenAI 高质量（VIP）',
  custom: '自带密钥（OpenAI 兼容）',
} as const;

export type EngineChoice = keyof typeof ENGINE_OPTIONS;

export const ENGINE_TIERS: Record<EngineChoice, 'free' | 'paid'> = {
  'google-free': 'free',
  microsoft: 'free',
  'qwen-free': 'free',
  'glm-free': 'free',
  'hunyuan-mt': 'free',
  google: 'paid',
  openai: 'paid',
  'openai-premium': 'paid',
  custom: 'free',
};

const ALL_TARGETS = Object.keys(TARGET_LANGUAGES) as TargetLang[];

/**
 * Target languages each engine can produce. Every engine currently covers the whole list; the
 * table stays because a future engine may not, and the UI greys out what an engine cannot reach.
 */
export const ENGINE_LANGUAGES: Record<EngineChoice, readonly TargetLang[]> = {
  'google-free': ALL_TARGETS,
  microsoft: ALL_TARGETS,
  'qwen-free': ALL_TARGETS,
  'glm-free': ALL_TARGETS,
  'hunyuan-mt': ALL_TARGETS,
  // Cantonese on the official Google API is not confirmed for the basic model, so it stays off.
  google: ALL_TARGETS.filter((lang) => lang !== 'yue'),
  openai: ALL_TARGETS,
  'openai-premium': ALL_TARGETS,
  custom: ALL_TARGETS,
};

/** Regions for the language picker, in the order they are shown. Every target language appears once. */
export const LANGUAGE_GROUPS: readonly { readonly id: string; readonly langs: readonly TargetLang[] }[] = [
  { id: 'eastAsia', langs: ['zh-CN', 'zh-TW', 'yue', 'ja', 'ko'] },
  { id: 'southeastAsia', langs: ['vi', 'th', 'id', 'ms', 'fil'] },
  { id: 'westEurope', langs: ['en', 'es', 'fr', 'de', 'it', 'pt', 'pt-BR', 'nl'] },
  { id: 'northEurope', langs: ['sv', 'da', 'nb', 'fi'] },
  { id: 'eastEurope', langs: ['ru', 'uk', 'pl', 'cs', 'sk', 'sl', 'hu', 'ro', 'bg', 'hr', 'el', 'et', 'lv', 'lt'] },
  { id: 'middleEast', langs: ['ar', 'he', 'fa', 'tr'] },
  { id: 'southAsia', langs: ['hi', 'bn', 'ur', 'ta'] },
  { id: 'africa', langs: ['sw'] },
];

export const engineSupports = (engine: EngineChoice, lang: TargetLang) => ENGINE_LANGUAGES[engine].includes(lang);

/**
 * What to translate: `article` reads like a reader view, only the main text; `page` also
 * translates interface text such as menus, tabs, buttons and form labels.
 *
 * The popup no longer offers the choice and everything runs as `page`: readers kept meeting
 * pages where the part they wanted sat in a menu, a tab or a table cell that article mode
 * dropped, and a setting that silently hides text is worse than translating a little extra.
 * Both modes stay in the extractor, and `sanitizeSettings` pins the stored value, so a profile
 * saved as `article` before 0.3.4 reads back as `page` without a migration step.
 */
export const SCOPES = ['article', 'page'] as const;
export type Scope = (typeof SCOPES)[number];

/** How a translated paragraph is shown: under the original, or in its place. */
export const DISPLAY_MODES = ['bilingual', 'translation'] as const;
export type DisplayMode = (typeof DISPLAY_MODES)[number];

/** The page's floating button: `auto` shows it on touch devices only, where there is no shortcut, menu or hover. */
export const FLOATING_MODES = ['auto', 'on', 'off'] as const;
export type FloatingMode = (typeof FLOATING_MODES)[number];

/** Translating what is typed into a text box, in place: by three spaces, by Alt+Enter, by either, or not at all. */
export const INPUT_TRANSLATE_MODES = ['off', 'spaces', 'key', 'both'] as const;
export type InputTranslateMode = (typeof INPUT_TRANSLATE_MODES)[number];

/**
 * The address of an OpenAI-compatible service the reader supplies (a hosted one, or Ollama on this machine). Plain http is
 * accepted only for this machine; anything else must be https, and an address with a login in it is refused.
 */
export function normalizeEndpoint(input: unknown): string {
  if (typeof input !== 'string') return '';
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return '';
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || !(url.protocol === 'https:' || (url.protocol === 'http:' && local))) return '';
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

export interface Settings {
  engine: EngineChoice;
  targetLang: TargetLang;
  scope: Scope;
  displayMode: DisplayMode;
  floatingButton: FloatingMode;
  inputTranslate: InputTranslateMode;
  /** When the chosen engine fails, or answers in the wrong language, the next free one translates instead. */
  engineFallback: boolean;
  /** The reader's own OpenAI-compatible service. Its key is kept apart from Settings (see api.ts). */
  customBaseUrl: string;
  customModel: string;
  /** Translations are kept on this device and reused; the text of the page itself is not stored. */
  translationCache: boolean;
  /** What typed text is turned into; separate from the page's target, which is usually the reader's own language. */
  inputLang: TargetLang;
  uiLang: UiLangSetting;
  fontScale: number;
  /** Empty string means "follow the page text color". */
  color: string;
  gap: number;
  showBorder: boolean;
  disabledSites: string[];
  /**
   * Sites that start translating on their own when the page is not already in the target language.
   * Each one needs its own host permission, granted by the user when the site is added.
   */
  autoTranslateSites: string[];
  /** Video subtitles (doc/03 FR-19): the translation line's own colours, over the picture. */
  subtitleColor: string;
  subtitleBackground: string;
  /** Selecting text on a page offers a lookup button (doc/03 FR-15). */
  selectionLookup: boolean;
  /** Keep a trace of what reading aloud does and show it on the page, for chasing a problem on a real device. */
  debugReading: boolean;
  privacyAcknowledged: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  engine: 'google-free',
  targetLang: 'zh-CN',
  scope: 'page',
  displayMode: 'bilingual',
  floatingButton: 'auto',
  inputTranslate: 'off',
  engineFallback: true,
  customBaseUrl: '',
  customModel: '',
  translationCache: true,
  inputLang: 'en',
  uiLang: 'auto',
  fontScale: 1,
  color: '',
  gap: 4,
  showBorder: true,
  disabledSites: [],
  autoTranslateSites: [],
  subtitleColor: '#ffffff',
  subtitleBackground: '#1f8a70',
  selectionLookup: true,
  debugReading: false,
  privacyAcknowledged: false,
};

const HOST_PATTERN = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/;

const clamp = (value: unknown, min: number, max: number, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

export function isTargetLang(value: unknown): value is TargetLang {
  return typeof value === 'string' && Object.hasOwn(TARGET_LANGUAGES, value);
}

export function normalizeHost(input: string): string | null {
  const raw = input.trim().toLowerCase();
  if (!raw) return null;
  let host = raw;
  try {
    host = new URL(raw.includes('://') ? raw : `https://${raw}`).hostname;
  } catch {
    return null;
  }
  host = host.replace(/^www\./, '');
  return HOST_PATTERN.test(host) ? host : null;
}

const colour = (value: unknown, fallback: string) =>
  typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : fallback;

/** Settings come from storage that any extension page can write; never trust their shape. */
export function sanitizeSettings(input: unknown): Settings {
  const s = (input && typeof input === 'object' ? input : {}) as Partial<Record<keyof Settings, unknown>>;
  const hosts = (value: unknown) =>
    [...new Set((Array.isArray(value) ? value : []).flatMap((x) => (typeof x === 'string' ? (normalizeHost(x) ?? []) : [])))];
  return {
    engine: typeof s.engine === 'string' && Object.hasOwn(ENGINE_OPTIONS, s.engine) ? (s.engine as EngineChoice) : DEFAULT_SETTINGS.engine,
    targetLang: isTargetLang(s.targetLang) ? s.targetLang : DEFAULT_SETTINGS.targetLang,
    // Pinned rather than read back: the choice is gone from the UI, so an old `article` must not linger.
    scope: 'page',
    displayMode: s.displayMode === 'translation' ? 'translation' : 'bilingual',
    floatingButton: s.floatingButton === 'on' || s.floatingButton === 'off' ? s.floatingButton : 'auto',
    inputTranslate: (INPUT_TRANSLATE_MODES as readonly unknown[]).includes(s.inputTranslate) ? (s.inputTranslate as InputTranslateMode) : 'off',
    customBaseUrl: normalizeEndpoint(s.customBaseUrl),
    customModel: typeof s.customModel === 'string' ? s.customModel.trim().slice(0, 100) : '',
    engineFallback: typeof s.engineFallback === 'boolean' ? s.engineFallback : DEFAULT_SETTINGS.engineFallback,
    translationCache: typeof s.translationCache === 'boolean' ? s.translationCache : DEFAULT_SETTINGS.translationCache,
    inputLang: isTargetLang(s.inputLang) ? s.inputLang : DEFAULT_SETTINGS.inputLang,
    uiLang: isUiLangSetting(s.uiLang) ? s.uiLang : DEFAULT_SETTINGS.uiLang,
    fontScale: clamp(s.fontScale, 0.7, 1.3, DEFAULT_SETTINGS.fontScale),
    color: typeof s.color === 'string' && /^#[0-9a-f]{6}$/i.test(s.color) ? s.color.toLowerCase() : '',
    gap: Math.round(clamp(s.gap, 0, 24, DEFAULT_SETTINGS.gap)),
    showBorder: typeof s.showBorder === 'boolean' ? s.showBorder : DEFAULT_SETTINGS.showBorder,
    disabledSites: hosts(s.disabledSites),
    autoTranslateSites: hosts(s.autoTranslateSites),
    // Colours go straight into a stylesheet, so only a plain hex value is ever accepted.
    subtitleColor: colour(s.subtitleColor, DEFAULT_SETTINGS.subtitleColor),
    subtitleBackground: colour(s.subtitleBackground, DEFAULT_SETTINGS.subtitleBackground),
    selectionLookup: typeof s.selectionLookup === 'boolean' ? s.selectionLookup : DEFAULT_SETTINGS.selectionLookup,
    debugReading: s.debugReading === true,
    privacyAcknowledged: s.privacyAcknowledged === true,
  };
}

const matchesSite = (sites: string[], hostname: string) => {
  const host = hostname.toLowerCase().replace(/^www\./, '');
  return sites.some((site) => host === site || host.endsWith(`.${site}`));
};

export function isSiteDisabled(settings: Settings, hostname: string): boolean {
  return matchesSite(settings.disabledSites, hostname);
}

export const isAutoTranslateSite = (settings: Settings, hostname: string) => matchesSite(settings.autoTranslateSites, hostname);

/** Host permission patterns for one site in the auto-translate list, covering its subdomains. */
export const siteOrigins = (site: string) => [`*://${site}/*`, `*://*.${site}/*`];

/** The pattern the "run on all sites" switch asks for. */
export const ALL_SITES_ORIGINS = ['*://*/*'];

/**
 * Where the content script is registered to run without a click first. With the all-sites grant it is
 * every page, so selection lookup is there before the reader has translated anything; otherwise only
 * the granted sites on the auto-translate list. The script translates by itself only on those listed
 * sites, so registering it everywhere does not start translating anywhere.
 */
export const autoScriptMatches = (allSitesGranted: boolean, grantedAutoSites: string[]): string[] =>
  allSitesGranted ? ALL_SITES_ORIGINS : grantedAutoSites.flatMap(siteOrigins);

/**
 * Whether the page is already written in the target language, going by the `lang` attribute alone:
 * `zh-TW` content counts as Chinese, and our engines cannot convert between Chinese variants anyway.
 * An absent or unparseable value answers false, so the extractor decides from the text instead.
 */
export function pageIsInTargetLanguage(pageLang: string | null | undefined, target: TargetLang): boolean {
  const primary = (tag: string) => tag.trim().toLowerCase().split(/[-_]/)[0] ?? '';
  const page = primary(pageLang ?? '');
  return page !== '' && page === primary(target);
}

const SETTINGS_VERSION_KEY = 'settingsVersion';

/**
 * Stored settings are explicit values, so changed defaults must be migrated once.
 * Each step brings settings from version (index + 1) to (index + 2).
 */
const MIGRATIONS: ((values: Record<string, unknown>) => Record<string, unknown>)[] = [
  // v2: translation text matches the original (same size and colour, no fading).
  (v) => ({ ...v, fontScale: 1, color: '' }),
  // v3: keep the left marker line by default.
  (v) => ({ ...v, showBorder: true }),
];
const SETTINGS_VERSION = MIGRATIONS.length + 1;

export function migrateSettings(raw: Record<string, unknown>): { values: Record<string, unknown>; changed: boolean } {
  const version = typeof raw[SETTINGS_VERSION_KEY] === 'number' ? (raw[SETTINGS_VERSION_KEY] as number) : 1;
  if (version >= SETTINGS_VERSION) return { values: raw, changed: false };
  const values = MIGRATIONS.slice(version - 1).reduce((v, step) => step(v), raw);
  return { values: { ...values, [SETTINGS_VERSION_KEY]: SETTINGS_VERSION }, changed: true };
}

export async function loadSettings(): Promise<Settings> {
  const raw = await chrome.storage.local.get(null);
  const { values, changed } = migrateSettings(raw);
  if (changed) await chrome.storage.local.set(values);
  return sanitizeSettings(values);
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = sanitizeSettings({ ...(await loadSettings()), ...patch });
  await chrome.storage.local.set(next);
  return next;
}
