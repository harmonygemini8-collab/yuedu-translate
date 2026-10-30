import { VOCAB_KEY, clearVocab, dueWords, gradeWord, loadVocab, removeWord, toAnkiText, toCsv, type VocabEntry } from '../shared/vocab';
import { GLOSSARY_KEY, clearGlossary, loadGlossary, removeTerm, saveTerm, type GlossaryEntry } from '../shared/glossary';
import type { Grade } from '../shared/srs';
import { idbCache } from '../shared/idb-cache';
import { testCustom } from '../background/custom-engine';
import {
  API_BASE,
  API_TOKEN_KEY,
  CUSTOM_KEY_KEY,
  IS_PUBLIC,
  SESSION_TOKEN_KEY,
  deleteAccount,
  effectiveEngine,
  fetchAccount,
  fetchServerStatus,
  fillEngineSelect,
  fillTargetSelect,
  hasBackend,
  loadApiToken,
  loadCustomKey,
  signOut,
  syncAvailability,
  type Account,
} from '../shared/api';
import {
  UI_LANGUAGES,
  applyTranslations,
  createTranslator,
  resolveUiLang,
  type MessageKey,
  type Translator,
  type UiLang,
  type UiLangSetting,
} from '../shared/i18n';
import { enhanceEngineSelect, type EnginePicker } from '../shared/engine-picker';
import { createLangPicker, type LangPicker } from '../shared/lang-picker';
import { HOMEPAGE_URL, SUPPORT_EMAIL, buildStamp, extensionVersion } from '../shared/links';
import { DEFAULT_SETTINGS, loadSettings, normalizeEndpoint, normalizeHost, saveSettings, siteOrigins, type EngineChoice, type Settings } from '../shared/settings';

const form = document.getElementById('settings') as HTMLFormElement;
const field = <T extends Element>(name: string) => form.elements.namedItem(name) as unknown as T;
const savedEl = document.getElementById('saved')!;
const preview = document.querySelector<HTMLElement>('.yilin-translation-preview')!;

// ── Sidebar navigation ──────────────────────────────────────────────────────
(function initNav() {
  const navBtns = document.querySelectorAll<HTMLButtonElement>('.nav-item');
  navBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      navBtns.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const target = btn.dataset['section']!;
      document.querySelectorAll<HTMLElement>('.settings-section').forEach((sec) => {
        sec.hidden = sec.id !== `sec-${target}`;
      });
    });
  });
  // Handle hash-based deep link (e.g. options.html#account).
  const hash = location.hash.replace('#', '');
  if (hash) {
    const btn = document.querySelector<HTMLButtonElement>(`.nav-item[data-section="${hash}"]`);
    if (btn) btn.click();
  }
})();

const targetLang = field<HTMLSelectElement>('targetLang');
const uiLang = field<HTMLSelectElement>('uiLang');
const fontScale = field<HTMLInputElement>('fontScale');
const gap = field<HTMLInputElement>('gap');
const followColor = field<HTMLInputElement>('followColor');
const selectionLookup = field<HTMLInputElement>('selectionLookup');
const floatingButton = field<HTMLSelectElement>('floatingButton');
const inputTranslate = field<HTMLSelectElement>('inputTranslate');
const engineFallback = field<HTMLInputElement>('engineFallback');
const translationCache = field<HTMLInputElement>('translationCache');
const customBaseUrl = field<HTMLInputElement>('customBaseUrl');
const customModel = field<HTMLInputElement>('customModel');
const customKey = field<HTMLInputElement>('customKey');
const inputLang = field<HTMLSelectElement>('inputLang');
const debugReading = field<HTMLInputElement>('debugReading');
const color = field<HTMLInputElement>('color');
const subtitleColor = field<HTMLInputElement>('subtitleColor');
const subtitleBackground = field<HTMLInputElement>('subtitleBackground');
const showBorder = field<HTMLInputElement>('showBorder');
const disabledSites = field<HTMLTextAreaElement>('disabledSites');
const engine = field<HTMLSelectElement>('engine');
const apiToken = field<HTMLInputElement>('apiToken');
const engineHint = document.getElementById('engine-hint')!;
const connectionStatus = document.getElementById('connection-status')!;

let t: Translator = createTranslator('zh-CN');
let currentLang: UiLang = 'zh-CN';
/** Rebuilt whenever the UI language changes, so language names follow it. */
let langPicker: LangPicker | undefined;
let enginePicker: EnginePicker | undefined;

fillTargetSelect(targetLang);
fillTargetSelect(inputLang);
// The development token and "development build" label never appear in the public build.
document.getElementById('connection')!.hidden = !hasBackend() || IS_PUBLIC;
document.querySelector<HTMLElement>('.mock-banner')!.hidden = IS_PUBLIC;
// A developer's tool: the store build does not show it.
document.getElementById('debug-row')!.hidden = IS_PUBLIC;
// The card around them collapses to nothing when both are empty, instead of showing a blank shell.
document.getElementById('dev-card')!.hidden = document.getElementById('debug-row')!.hidden && document.getElementById('connection')!.hidden;

// ---- Account (doc/15 §9.1): only meaningful in builds that talk to the Yuedu server.
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
$('nav-account').hidden = !hasBackend();
const accStatus = $('acc-status');
let account: Account | null = null;
let pollTimer: ReturnType<typeof setInterval> | undefined;

const formatDate = (iso: string) => new Date(iso).toLocaleDateString(currentLang);
const formatNumber = (n: number) => n.toLocaleString(currentLang);

function accountError(error: string) {
  const known: Record<string, MessageKey> = {
    CODE_INVALID: 'account.codeInvalid',
    RATE_LIMITED: 'account.tooMany',
    REGISTRATION_DISABLED: 'account.notInvited',
  };
  accStatus.textContent = known[error] ? t(known[error], { email: SUPPORT_EMAIL }) : t('account.failed', { error });
}

function renderAccount() {
  $('signed-out').hidden = !!account;
  $('signed-in').hidden = !account;
  if (!account) return;
  $('acc-user').textContent = account.user.email;
  $('acc-plan').textContent = account.plan.id === 'free' || !account.plan.periodEnd
    ? t('account.planFree')
    : t('account.planPro', { date: formatDate(account.plan.periodEnd) });
  $('acc-trial').hidden = account.plan.id !== 'free';
  $('acc-quotas').replaceChildren(...Object.entries(account.quotas).map(([pool, q]) => {
    const li = document.createElement('li');
    const colon = currentLang.startsWith('zh') ? '：' : ': ';
    li.textContent = `${t(`account.pool.${pool}` as MessageKey)}${colon}${t('account.quota', { used: formatNumber(q.used), limit: formatNumber(q.limit), date: formatDate(q.resetAt) })}`;
    return li;
  }));
}

async function refreshAccount() {
  const result = await fetchAccount();
  if (result.ok) account = result.data;
  else accountError(result.error);
  renderAccount();
}

/** Open the website login page and poll for the token the website will store after sign-in. */
function openWebLogin() {
  if (pollTimer) clearInterval(pollTimer);
  const state = crypto.randomUUID();
  // getyuedu.com's own site, not the retired www.warptech.cc (doc/13 §7.1: that name now
  // just 301s here, which is how this was verified before the switch).
  const loginUrl = `https://getyuedu.com/login?from=extension&state=${state}&lang=${currentLang}`;
  window.open(loginUrl, '_blank', 'noopener');
  const pollStatus = $('acc-poll-status');
  pollStatus.textContent = t('account.waitingForLogin');

  let attempts = 0;
  pollTimer = setInterval(async () => {
    attempts++;
    if (attempts > 100) { // ~5 minutes at 3s interval
      clearInterval(pollTimer);
      pollStatus.textContent = '';
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/v1/auth/link-state/${state}`, { signal: AbortSignal.timeout(5_000) });
      const body = (await res.json()) as { ok?: boolean; pending?: boolean; token?: string };
      if (body.token) {
        clearInterval(pollTimer);
        pollStatus.textContent = '';
        await chrome.storage.local.set({ [SESSION_TOKEN_KEY]: body.token });
        await refreshAccount();
      }
    } catch { /* network blip — keep polling */ }
  }, 3_000);
}

$('acc-web-login').addEventListener('click', openWebLogin);

$('acc-logout').addEventListener('click', async () => {
  if (pollTimer) { clearInterval(pollTimer); $('acc-poll-status').textContent = ''; }
  await signOut();
  account = null;
  renderAccount();
});
$('acc-delete').addEventListener('click', async () => {
  if (!confirm(t('account.deleteConfirm'))) return;
  const result = await deleteAccount();
  if (!result.ok) return accountError(result.error);
  account = null;
  renderAccount();
});

/** (Re)render every piece of UI text in the chosen interface language. */
function localize(setting: UiLangSetting) {
  const lang = resolveUiLang(setting);
  currentLang = lang;
  t = createTranslator(lang);
  applyTranslations(document, lang, t);
  fillEngineSelect(engine, t);
  uiLang.replaceChildren(
    new Option(t('uiLang.auto'), 'auto'),
    ...Object.entries(UI_LANGUAGES).map(([value, label]) => new Option(label, value)),
  );
  connectionStatus.textContent = '';
  langPicker = createLangPicker(targetLang, lang, t);
  // Rebuilt with the labels of the new interface language; the widget only mirrors the select.
  enginePicker ??= enhanceEngineSelect(engine);
  enginePicker.refresh();
  renderAccount();
}

function fill(s: Settings) {
  engine.value = effectiveEngine(s.engine);
  engineHint.textContent = t(`hint.${effectiveEngine(s.engine)}`);
  targetLang.value = s.targetLang;
  uiLang.value = s.uiLang;
  syncAvailability(engine, targetLang);
  enginePicker?.refresh();
  langPicker?.refresh();
  fontScale.value = String(s.fontScale);
  gap.value = String(s.gap);
  followColor.checked = !s.color;
  color.value = s.color || '#2f6f5e';
  color.disabled = !s.color;
  subtitleColor.value = s.subtitleColor;
  subtitleBackground.value = s.subtitleBackground;
  showBorder.checked = s.showBorder;
  selectionLookup.checked = s.selectionLookup;
  floatingButton.value = s.floatingButton;
  inputTranslate.value = s.inputTranslate;
  engineFallback.checked = s.engineFallback;
  translationCache.checked = s.translationCache;
  if (document.activeElement !== customBaseUrl) customBaseUrl.value = s.customBaseUrl;
  if (document.activeElement !== customModel) customModel.value = s.customModel;
  inputLang.value = s.inputLang;
  document.getElementById('input-tip')!.hidden = s.inputTranslate === 'off';
  debugReading.checked = s.debugReading;
  if (document.activeElement !== disabledSites) disabledSites.value = s.disabledSites.join('\n');
  renderAutoSites(s.autoTranslateSites);
  updatePreview(s);
}

// ---- Auto-translate sites. Each one needs its own host permission, which Chrome only grants
// from a user gesture, so sites are added with a button instead of the settings form's textarea.
const autoHost = $<HTMLInputElement>('auto-host');
const autoList = $('auto-list');
const autoStatus = $('auto-status');

/**
 * One grant instead of adding sites one by one. The pattern is already in
 * `optional_host_permissions`, so offering it here costs nothing at install time: the broad
 * prompt appears only for a user who asks for it. It also reaches a document embedded from
 * another domain, which a per-site grant cannot cover without knowing that domain first.
 */
const ALL_SITES = { origins: ['*://*/*'] };
const allSites = $<HTMLInputElement>('all-sites');

/** Lookup only appears on pages that already have the content script; say so while that is not every page. */
function renderLookupScope() {
  $('lookup-scope').hidden = !selectionLookup.checked || allSites.checked;
}

async function syncAllSites() {
  try {
    allSites.checked = await chrome.permissions.contains(ALL_SITES);
  } catch {
    allSites.checked = false;
  }
  renderLookupScope();
}

async function toggleAllSites() {
  const wanted = allSites.checked;
  // Chrome only prompts during a user gesture, and awaiting anything first ends that gesture,
  // so the request has to be this handler's first await.
  let ok = false;
  try {
    ok = wanted ? await chrome.permissions.request(ALL_SITES) : await chrome.permissions.remove(ALL_SITES);
  } catch {
    ok = false;
  }
  if (wanted && !ok) {
    autoStatus.textContent = t('auto.allSitesDenied');
  } else {
    autoStatus.textContent = '';
  }
  await syncAllSites();
}

$('lookup-enable-all').addEventListener('click', () => {
  allSites.checked = true;
  void toggleAllSites();
});
selectionLookup.addEventListener('change', renderLookupScope);

function renderAutoSites(sites: string[]) {
  autoList.replaceChildren(...sites.map((site) => {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = t('auto.remove');
    remove.addEventListener('click', () => void removeAutoSite(site));
    const item = document.createElement('li');
    item.append(`${site} `, remove);
    return item;
  }));
  autoList.hidden = sites.length === 0;
}

async function addAutoSite() {
  const host = normalizeHost(autoHost.value);
  if (!host) {
    autoStatus.textContent = t('auto.invalid');
    return;
  }
  // Chrome only prompts for a permission during a user gesture, and awaiting anything first ends
  // that gesture, so this must stay the handler's very first await. Asking again for a permission
  // that is already granted simply returns true without a prompt.
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: siteOrigins(host) });
  } catch {
    granted = false;
  }
  if (!granted) {
    autoStatus.textContent = t('auto.denied');
    return;
  }
  const settings = await loadSettings();
  if (!settings.autoTranslateSites.includes(host)) {
    await saveSettings({ autoTranslateSites: [...settings.autoTranslateSites, host] });
  }
  autoHost.value = '';
  autoStatus.textContent = '';
  renderAutoSites((await loadSettings()).autoTranslateSites);
  flashSaved();
}

async function removeAutoSite(host: string) {
  const settings = await loadSettings();
  await saveSettings({ autoTranslateSites: settings.autoTranslateSites.filter((s) => s !== host) });
  // Hand the host permission back; the user granted it only for automatic translation.
  await chrome.permissions.remove({ origins: siteOrigins(host) }).catch(() => false);
  renderAutoSites((await loadSettings()).autoTranslateSites);
  flashSaved();
}

function updatePreview(s: Settings) {
  document.querySelector<HTMLElement>('output[data-for="fontScale"]')!.textContent = `${Math.round(s.fontScale * 100)}%`;
  document.querySelector<HTMLElement>('output[data-for="gap"]')!.textContent = `${s.gap}px`;
  Object.assign(preview.style, {
    fontSize: `${s.fontScale}em`,
    marginTop: `${s.gap}px`,
    color: s.color || 'inherit',
    borderInlineStart: s.showBorder ? '2px solid currentColor' : '0',
    paddingInlineStart: s.showBorder ? '0.6em' : '0',
  });
}

function flashSaved(text = t('saved.settings')) {
  savedEl.textContent = text;
  setTimeout(() => (savedEl.textContent = ''), 1500);
}

async function save(event?: Event) {
  const next = await saveSettings({
    // Only persist the engine when the user actually changed it; the select shows the
    // *effective* engine, which must not overwrite the stored choice as a side effect.
    ...(event?.target === engine ? { engine: engine.value as EngineChoice } : {}),
    targetLang: targetLang.value as Settings['targetLang'],
    uiLang: uiLang.value as UiLangSetting,
    fontScale: Number(fontScale.value),
    gap: Number(gap.value),
    color: followColor.checked ? '' : color.value,
    subtitleColor: subtitleColor.value,
    subtitleBackground: subtitleBackground.value,
    showBorder: showBorder.checked,
    selectionLookup: selectionLookup.checked,
    floatingButton: floatingButton.value as Settings['floatingButton'],
    inputTranslate: inputTranslate.value as Settings['inputTranslate'],
    engineFallback: engineFallback.checked,
    translationCache: translationCache.checked,
    customBaseUrl: customBaseUrl.value,
    customModel: customModel.value,
    inputLang: inputLang.value as Settings['inputLang'],
    debugReading: debugReading.checked,
    disabledSites: disabledSites.value.split(/\r?\n/),
  });
  if (event?.target === uiLang) localize(next.uiLang);
  fill(next);
  flashSaved();
}

/** Homepage and support address, so users can reach us from inside the extension. */
function fillAbout() {
  const home = document.getElementById('about-home') as HTMLAnchorElement;
  const mail = document.getElementById('about-mail') as HTMLAnchorElement;
  document.getElementById('about-version')!.textContent = `${extensionVersion()} · ${buildStamp()}`;
  home.href = HOMEPAGE_URL;
  home.textContent = HOMEPAGE_URL.replace(/^https?:\/\/|\/$/g, '');
  mail.href = `mailto:${SUPPORT_EMAIL}`;
  mail.textContent = SUPPORT_EMAIL;
}

async function init() {
  const settings = await loadSettings();
  localize(settings.uiLang);
  fillAbout();
  fill(settings);
  if (hasBackend()) void refreshAccount();
  form.addEventListener('input', (e) => e.target !== disabledSites && e.target !== apiToken && e.target !== customKey && void save(e));
  disabledSites.addEventListener('change', () => void save());
  // Show what went wrong instead of letting the button look inert.
  allSites.addEventListener('change', () => void toggleAllSites());
  chrome.permissions.onAdded.addListener(() => void syncAllSites());
  chrome.permissions.onRemoved.addListener(() => void syncAllSites());
  void syncAllSites();
  const add = () => void addAutoSite().catch((err: unknown) => (autoStatus.textContent = String(err)));
  $('auto-add').addEventListener('click', add);
  autoHost.addEventListener('keydown', (e) => (e as KeyboardEvent).key === 'Enter' && add());

  apiToken.value = await loadApiToken();
  apiToken.addEventListener('change', async () => {
    await chrome.storage.local.set({ [API_TOKEN_KEY]: apiToken.value.trim() });
    flashSaved(t('saved.token'));
  });
  document.getElementById('test-connection')!.addEventListener('click', async () => {
    connectionStatus.textContent = t('connection.testing');
    const result = await fetchServerStatus(apiToken.value.trim());
    if (!result.ok) {
      connectionStatus.textContent = result.error === 'UNAUTHENTICATED' ? t('connection.badToken') : t('connection.failed', { error: result.error });
      return;
    }
    const { engines, usage } = result.status;
    const lines = (Object.keys(engines) as (keyof typeof engines)[]).filter((e) => e !== 'azure-tts').map((e) => {
      const limit = usage.charLimits[e];
      const quota = limit !== undefined ? t('connection.quota', { used: usage.chars[e] ?? 0, limit }) : '';
      return `${t(`engine.${e}`)}: ${engines[e] ? `${t('connection.available')}${quota}` : t('connection.unavailable')}`;
    });
    connectionStatus.textContent = `${t('connection.ok', { cost: usage.costUsd, budget: usage.budgetUsd })}\n${lines.join('\n')}`;
  });

  const ackRow = document.getElementById('ack-row')!;
  ackRow.hidden = settings.privacyAcknowledged;
  document.getElementById('ack')!.addEventListener('click', async () => {
    await saveSettings({ privacyAcknowledged: true });
    ackRow.hidden = true;
    flashSaved(t('saved.ack'));
  });

  document.getElementById('reset')!.addEventListener('click', async () => {
    if (!confirm(t('data.confirm'))) return;
    await chrome.storage.local.clear();
    localize(DEFAULT_SETTINGS.uiLang);
    fill(DEFAULT_SETTINGS);
    apiToken.value = '';
    ackRow.hidden = false;
    flashSaved(t('saved.cleared'));
  });
}

void init();

document.getElementById('cache-clear')!.addEventListener('click', async () => {
  const status = document.getElementById('cache-status')!;
  try {
    await idbCache.clear();
    status.textContent = t('cache.cleared');
  } catch {
    status.textContent = '';
  }
  setTimeout(() => (status.textContent = ''), 2500);
});

// The reader's own service: the key is kept apart from the settings, and the address needs the browser's permission to be reached.
void (async () => {
  customKey.value = await loadCustomKey();
  customKey.addEventListener('change', async () => {
    await chrome.storage.local.set({ [CUSTOM_KEY_KEY]: customKey.value.trim() });
    flashSaved(t('saved.token'));
  });
  const status = document.getElementById('custom-status')!;
  document.getElementById('custom-test')!.addEventListener('click', async () => {
    const baseUrl = normalizeEndpoint(customBaseUrl.value);
    status.textContent = '';
    if (!baseUrl || !customModel.value.trim()) {
      status.textContent = t('custom.failed');
      return;
    }
    status.textContent = t('custom.testing');
    const granted = await chrome.permissions.request({ origins: [`${new URL(baseUrl).origin}/*`] }).catch(() => false);
    if (!granted) {
      status.textContent = t('custom.noPermission');
      return;
    }
    const result = await testCustom({ baseUrl, model: customModel.value.trim(), key: customKey.value.trim() });
    const reasons: Record<string, MessageKey> = { NOT_CONFIGURED: 'custom.badKey', INVALID_REQUEST: 'custom.badAddress', NETWORK: 'custom.network', RATE_LIMITED: 'custom.limited' };
    status.textContent = result.ok ? t('custom.ok') : `${t(reasons[result.error] ?? 'custom.failed')}${result.detail ? ` (${result.detail})` : ''}`;
  });
})();

// ── Word book ────────────────────────────────────────────────────────────────
void (function initVocab() {
  const list = document.getElementById('vocab-list')!;
  const search = document.getElementById('vocab-search') as HTMLInputElement;
  const count = document.getElementById('vocab-count')!;
  const empty = document.getElementById('vocab-empty')!;
  const reviewBar = document.getElementById('vocab-review-bar')!;
  const dueCountEl = document.getElementById('vocab-due-count')!;
  const card = document.getElementById('vocab-review-card')!;
  const front = document.getElementById('vocab-review-front')!;
  const back = document.getElementById('vocab-review-back')!;
  const reveal = document.getElementById('vocab-review-reveal')!;
  const grades = document.getElementById('vocab-review-grades')!;
  const progress = document.getElementById('vocab-review-progress')!;
  let entries: VocabEntry[] = [];
  let reviewQueue: VocabEntry[] = [];
  let reviewIndex = 0;
  let reviewing = false;

  function render() {
    search.placeholder = t('vocab.search');
    const q = search.value.trim().toLowerCase();
    const shown = entries.filter((e) => !q || `${e.text} ${e.translation} ${e.context ?? ''}`.toLowerCase().includes(q));
    count.textContent = t('vocab.count', { n: entries.length });
    empty.hidden = entries.length > 0;
    list.replaceChildren(
      ...shown.map((e) => {
        const li = document.createElement('li');
        const head = document.createElement('div');
        const word = document.createElement('strong');
        word.textContent = e.text;
        const phonetic = document.createElement('span');
        phonetic.className = 'hint';
        phonetic.textContent = e.phonetic ?? '';
        const del = document.createElement('button');
        del.type = 'button';
        del.textContent = '✕';
        del.title = t('vocab.delete');
        del.setAttribute('aria-label', t('vocab.delete'));
        del.addEventListener('click', () => void removeWord(e.id));
        head.append(word, ' ', phonetic, del);
        const meaning = document.createElement('div');
        meaning.textContent = [e.translation, ...(e.senses ?? []).map((s) => `${s.pos} ${s.meaning}`)].join(' · ');
        li.append(head, meaning);
        if (e.context) {
          const sentence = document.createElement('div');
          sentence.className = 'hint';
          sentence.textContent = e.context;
          li.append(sentence);
        }
        return li;
      }),
    );
    // Not touched while a review is in progress: grading mid-session must not yank the card away.
    if (!reviewing) {
      const due = dueWords(entries);
      reviewBar.hidden = due.length === 0;
      dueCountEl.textContent = t('vocab.dueCount', { n: due.length });
    }
  }

  async function refresh() {
    entries = await loadVocab();
    render();
  }
  search.addEventListener('input', render);
  document.getElementById('vocab-export')!.addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([toCsv(entries)], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `yuedu-wordbook-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  document.getElementById('vocab-export-anki')!.addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([toAnkiText(entries)], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `yuedu-wordbook-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  document.getElementById('vocab-clear')!.addEventListener('click', async () => {
    if (entries.length > 0 && confirm(t('vocab.confirmClear'))) await clearVocab();
  });

  // ── Review (doc/25 §1.2: spaced repetition, two grades) ──────────────────
  function showCard() {
    if (reviewIndex >= reviewQueue.length) {
      reviewing = false;
      card.hidden = true;
      render();
      return;
    }
    const e = reviewQueue[reviewIndex]!;
    front.textContent = [e.text, e.phonetic].filter(Boolean).join('  ');
    back.replaceChildren();
    const translation = document.createElement('div');
    translation.textContent = [e.translation, ...(e.senses ?? []).map((s) => `${s.pos} ${s.meaning}`)].join(' · ');
    back.append(translation);
    if (e.context) {
      const sentence = document.createElement('div');
      sentence.className = 'hint';
      sentence.textContent = e.context;
      back.append(sentence);
    }
    back.hidden = true;
    reveal.hidden = false;
    grades.hidden = true;
    progress.textContent = t('vocab.reviewProgress', { done: reviewIndex + 1, total: reviewQueue.length });
  }
  document.getElementById('vocab-review-start')!.addEventListener('click', () => {
    reviewQueue = dueWords(entries);
    reviewIndex = 0;
    reviewing = true;
    reviewBar.hidden = true;
    card.hidden = false;
    showCard();
  });
  reveal.addEventListener('click', () => {
    back.hidden = false;
    reveal.hidden = true;
    grades.hidden = false;
  });
  async function grade(g: Grade) {
    const current = reviewQueue[reviewIndex];
    if (current) await gradeWord(current.id, g);
    reviewIndex++;
    showCard();
  }
  document.getElementById('vocab-grade-again')!.addEventListener('click', () => void grade('again'));
  document.getElementById('vocab-grade-good')!.addEventListener('click', () => void grade('good'));

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && VOCAB_KEY in changes) void refresh();
  });
  // The page language can change while the list is open.
  document.getElementById('uiLang')?.addEventListener('change', () => setTimeout(render, 0));
  void refresh();
})();

// ── Project-level glossary (doc/25 §1.1: user-managed terms, one translation per word per language) ──────
void (function initGlossary() {
  const term = document.getElementById('glossary-term') as HTMLInputElement;
  const translation = document.getElementById('glossary-translation') as HTMLInputElement;
  const lang = document.getElementById('glossary-lang') as HTMLSelectElement;
  const add = document.getElementById('glossary-add')!;
  const error = document.getElementById('glossary-error')!;
  const list = document.getElementById('glossary-list')!;
  const search = document.getElementById('glossary-search') as HTMLInputElement;
  const count = document.getElementById('glossary-count')!;
  const empty = document.getElementById('glossary-empty')!;
  let entries: GlossaryEntry[] = [];
  fillTargetSelect(lang);

  function render() {
    search.placeholder = t('glossary.search');
    const q = search.value.trim().toLowerCase();
    const shown = entries.filter((e) => !q || `${e.term} ${e.translation}`.toLowerCase().includes(q));
    count.textContent = t('vocab.count', { n: entries.length });
    empty.hidden = entries.length > 0;
    list.replaceChildren(
      ...shown.map((e) => {
        const li = document.createElement('li');
        const head = document.createElement('div');
        const word = document.createElement('strong');
        word.textContent = e.term;
        const del = document.createElement('button');
        del.type = 'button';
        del.textContent = '✕';
        del.title = t('vocab.delete');
        del.setAttribute('aria-label', t('vocab.delete'));
        del.addEventListener('click', () => void removeTerm(e.id));
        head.append(word, ' → ', e.translation, del);
        li.append(head);
        return li;
      }),
    );
  }

  async function refresh() {
    entries = await loadGlossary();
    render();
  }
  search.addEventListener('input', render);
  lang.value = targetLang.value;
  add.addEventListener('click', async () => {
    error.hidden = true;
    const termValue = term.value.trim();
    const translationValue = translation.value.trim();
    if (!termValue || !translationValue) return;
    const result = await saveTerm({ term: termValue, translation: translationValue, lang: lang.value as Settings['targetLang'] });
    if (result === 'full') {
      error.textContent = t('glossary.full');
      error.hidden = false;
      return;
    }
    term.value = '';
    translation.value = '';
    term.focus();
  });
  document.getElementById('glossary-clear')!.addEventListener('click', async () => {
    if (entries.length > 0 && confirm(t('vocab.confirmClear'))) await clearGlossary();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && GLOSSARY_KEY in changes) void refresh();
  });
  document.getElementById('uiLang')?.addEventListener('change', () => setTimeout(render, 0));
  void refresh();
})();
