import {
  isRestrictedUrl,
  type ContentRequest,
  type ContentResponse,
  type PageCommand,
  type PageState,
  type StateChangedMessage,
} from '../shared/messages';
import {
  API_BASE,
  SESSION_TOKEN_KEY,
  effectiveEngine,
  fetchAccount,
  fillEngineSelect,
  fillTargetSelect,
  isVipEngine,
  loadAuthToken,
  needsBackend,
  syncAvailability,
  type Account,
} from '../shared/api';
import { applyTranslations, createTranslator, resolveUiLang, type Translator } from '../shared/i18n';
import { enhanceEngineSelect } from '../shared/engine-picker';
import { createLangPicker, type LangPicker } from '../shared/lang-picker';
import { HOMEPAGE_URL } from '../shared/links';
import {
  ALL_SITES_ORIGINS,
  isSiteDisabled,
  loadSettings,
  saveSettings,
  type DisplayMode,
  type EngineChoice,
  type Settings,
  type TargetLang,
} from '../shared/settings';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $<HTMLParagraphElement>('page-status');
const displayModeButton = $<HTMLButtonElement>('display-mode');
const displayModeTip = $<HTMLSpanElement>('display-tip');
const buttons = {
  start: $<HTMLButtonElement>('start'),
  stop: $<HTMLButtonElement>('stop'),
  restore: $<HTMLButtonElement>('restore'),
  retry: $<HTMLButtonElement>('retry'),
  tts: $<HTMLButtonElement>('tts'),
};

let tab: chrome.tabs.Tab | undefined;
let t: Translator = createTranslator('zh-CN');
let uiLangCode = 'zh-CN';
/** Signed-in account, fetched once per popup; null when signed out or unknown. */
let account: Account | null = null;

const POOL_OF: Partial<Record<EngineChoice, keyof Account['quotas']>> = {
  microsoft: 'free_daily',
  'qwen-free': 'free_daily',
  'glm-free': 'free_daily',
  'hunyuan-mt': 'free_daily',
  google: 'pro_standard', openai: 'pro_standard', 'openai-premium': 'pro_premium',
};

/**
 * Who is signed in, at the top of the popup.
 *
 * The button opens the account section of the options page rather than asking for the address
 * here: signing in means reading a code out of an email, and a browser popup closes as soon as
 * it loses focus, so the half-finished form would be gone by the time the code arrived.
 */
function renderAccountBar() {
  const who = $<HTMLSpanElement>('account-who');
  const action = $<HTMLButtonElement>('account-action');
  if (!account) {
    who.textContent = t('popup.signedOut');
    delete who.dataset.plan;
    action.textContent = t('popup.signIn');
    return;
  }
  const pro = account.plan.id !== 'free';
  who.textContent = account.user.email;
  who.dataset.plan = pro ? 'pro' : 'free';
  who.title = `${account.user.email} · ${pro ? 'Pro' : t('account.planFree')}`;
  action.textContent = t('popup.manage');
}

/** Status line: where the text goes, or what is missing (sign-in, VIP), plus the remaining quota. */
async function renderEngineNote(settings: Settings) {
  const banner = $<HTMLParagraphElement>('engine-banner');
  const engine = effectiveEngine(settings.engine);
  let text = t(`note.${engine}`);
  let warn = false;
  if (needsBackend(engine)) {
    const pool = account ? account.quotas[POOL_OF[engine]!] : undefined;
    // A free engine that needs an account is not a paywall; say so, or the banner reads like one.
    if (!(await loadAuthToken())) [text, warn] = [t(isVipEngine(engine) ? 'note.loginRequired' : 'note.loginRequiredFree'), true];
    else if (account && isVipEngine(engine) && account.plan.id === 'free') [text, warn] = [t('note.planRequired'), true];
    else if (pool) text += ` · ${t('note.quotaLeft', { n: Math.max(0, pool.limit - pool.used).toLocaleString(uiLangCode) })}`;
  }
  banner.textContent = text;
  banner.dataset.kind = warn ? 'warn' : engine;
}

function showMessage(text: string, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
}

function render(state: PageState) {
  const { status, total, translated, failed, pending } = state;
  const counts = [
    t('count.translated', { n: translated }),
    ...(failed ? [t('count.failed', { n: failed })] : []),
    ...(pending ? [t('count.pending', { n: pending })] : []),
  ].join(' · ');
  const text = {
    idle: t('status.idle'),
    translating: t('status.translating', { counts }),
    done: total ? t('status.done', { counts }) : t('status.noContent'),
    stopped: t('status.stopped', { counts }),
  }[status];
  // The service refused the whole page: that, not the paragraph counts, is what the reader needs.
  if (state.blocked === 'RATE_LIMITED') showMessage(t('status.rateLimited'), true);
  else showMessage(text);
  buttons.start.textContent = status === 'stopped' ? t('action.resume') : t('action.translate');
  buttons.start.disabled = status === 'translating' || status === 'done';
  buttons.stop.disabled = status !== 'translating' && status !== 'done';
  buttons.restore.disabled = status === 'idle';
  buttons.retry.disabled = failed === 0;
  // Show the TTS button once there is translated content; label reflects current speaking state.
  const hasDone = translated > 0;
  buttons.tts.hidden = !hasDone;
  buttons.tts.textContent = state.speaking ? t('tts.stop') : t('tts.read');
}

/** The switch shows the current display mode; the tooltip says what a click will change it to. */
function renderDisplayMode(mode: DisplayMode) {
  const names: Record<DisplayMode, string> = { bilingual: t('display.bilingual'), translation: t('display.translation') };
  const next: DisplayMode = mode === 'bilingual' ? 'translation' : 'bilingual';
  const tip = t('display.tip', { mode: names[mode], next: names[next] });
  displayModeButton.dataset['mode'] = mode;
  displayModeButton.setAttribute('aria-label', tip);
  displayModeButton.setAttribute('aria-pressed', String(mode === 'translation'));
  displayModeTip.textContent = tip;
  $('display-mode').querySelector('.mode-label')!.textContent = names[mode];
}

function setDisabled(message: string) {
  Object.values(buttons).forEach((b) => (b.disabled = true));
  showMessage(message, true);
}

/** True when the page took the command; false when it could not run or the site is switched off (the popup then says why). */
async function send(type: PageCommand, inject: boolean): Promise<boolean> {
  if (!tab?.id) return false;
  try {
    if (inject) await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['content.js'] });
    const request: ContentRequest = { type };
    const response = (await chrome.tabs.sendMessage(tab.id, request)) as ContentResponse;
    if (response.ok) render(response.state);
    else setDisabled(t('error.siteDisabled'));
    return response.ok;
  } catch {
    if (type === 'GET_STATE') render({ status: 'idle', total: 0, translated: 0, failed: 0, pending: 0 });
    else setDisabled(t('error.cannotRun'));
    return false;
  }
}

async function init() {
  const settings = await loadSettings();
  const uiLang = resolveUiLang(settings.uiLang);
  uiLangCode = uiLang;
  t = createTranslator(uiLang);
  applyTranslations(document, uiLang, t);
  $<HTMLAnchorElement>('home-link').href = HOMEPAGE_URL;
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  const targetSelect = $<HTMLSelectElement>('target-lang');
  const engineSelect = $<HTMLSelectElement>('engine');
  fillTargetSelect(targetSelect);
  fillEngineSelect(engineSelect, t);
  targetSelect.value = settings.targetLang;
  engineSelect.value = effectiveEngine(settings.engine);
  syncAvailability(engineSelect, targetSelect);
  const enginePicker = enhanceEngineSelect(engineSelect);
  const langPicker = createLangPicker(targetSelect, uiLang, t);


  targetSelect.addEventListener('change', async () => {
    Object.assign(settings, await saveSettings({ targetLang: targetSelect.value as TargetLang }));
    syncAvailability(engineSelect, targetSelect);
    // A language the current engine cannot reach greys that engine out in the list.
    enginePicker.refresh();
  });
  engineSelect.addEventListener('change', async () => {
    Object.assign(settings, await saveSettings({ engine: engineSelect.value as EngineChoice }));
    syncAvailability(engineSelect, targetSelect);
    enginePicker.refresh();
    // The new engine may not reach the chosen language; the picker greys those rows out.
    langPicker.refresh();
    await renderEngineNote(settings);
  });
  await renderEngineNote(settings);
  // Account state arrives over the network; refine the status line once it is known.
  renderAccountBar();
  void fetchAccount().then((result) => {
    if (result.ok && result.data) {
      account = result.data;
      void renderEngineNote(settings);
    }
    renderAccountBar();
  });
  // Open the website login page directly; store state so the popup can pick up the token on next open.
  $('account-action').addEventListener('click', () => {
    if (account) {
      void chrome.tabs.create({ url: chrome.runtime.getURL('options.html#account') });
      window.close();
      return;
    }
    const state = crypto.randomUUID();
    void chrome.storage.local.set({ pendingLoginState: state });
    // getyuedu.com's own site, not the retired www.warptech.cc (doc/13 §7.1: that name now
    // just 301s here, which is how this was verified before the switch).
    const loginUrl = `https://getyuedu.com/login?from=extension&state=${state}&lang=${uiLangCode}`;
    void chrome.tabs.create({ url: loginUrl });
    window.close();
  });

  // If there is a pending login from a previous click, poll the server until the token arrives.
  void (async () => {
    if (!API_BASE) return;
    const stored = await chrome.storage.local.get('pendingLoginState');
    const state = stored['pendingLoginState'] as string | undefined;
    if (!state) return;
    let attempts = 0;
    const poll = async (): Promise<void> => {
      attempts++;
      if (attempts > 100) { void chrome.storage.local.remove('pendingLoginState'); return; }
      try {
        const res = await fetch(`${API_BASE}/v1/auth/link-state/${state}`, { signal: AbortSignal.timeout(5_000) });
        const body = await res.json() as { ok?: boolean; pending?: boolean; token?: string };
        if (body.token) {
          await chrome.storage.local.remove('pendingLoginState');
          await chrome.storage.local.set({ [SESSION_TOKEN_KEY]: body.token });
          location.reload();
          return;
        }
      } catch { /* network blip — keep polling */ }
      setTimeout(() => void poll(), 3_000);
    };
    void poll();
  })();

  $('open-options').addEventListener('click', () => void chrome.runtime.openOptionsPage());
  renderDisplayMode(settings.displayMode);
  displayModeButton.addEventListener('click', async () => {
    const next: DisplayMode = settings.displayMode === 'bilingual' ? 'translation' : 'bilingual';
    Object.assign(settings, await saveSettings({ displayMode: next }));
    renderDisplayMode(settings.displayMode);
  });
  // On a touch screen the page's floating button and the lookup need the all-sites grant; offer it once, here.
  void (async () => {
    if (!window.matchMedia('(pointer: coarse)').matches) return;
    try {
      if (await chrome.permissions.contains({ origins: ALL_SITES_ORIGINS })) return;
    } catch {
      return;
    }
    const enableAll = $<HTMLButtonElement>('enable-all');
    enableAll.hidden = false;
    // Chrome only prompts inside a user gesture, so the request is the handler's first await.
    enableAll.addEventListener('click', async () => {
      if (await chrome.permissions.request({ origins: ALL_SITES_ORIGINS })) enableAll.hidden = true;
    });
  })();
  // Every action happens on the page, where its effect is visible, so the popup gets out of the way. When the
  // page cannot take the command it stays open, because that is where the reason is shown.
  const act = (type: PageCommand, inject = false) => void send(type, inject).then((done) => done && window.close());
  buttons.start.addEventListener('click', () => act('START', true));
  buttons.stop.addEventListener('click', () => act('STOP'));
  buttons.restore.addEventListener('click', () => act('RESTORE'));
  buttons.retry.addEventListener('click', () => act('RETRY_FAILED'));
  buttons.tts.addEventListener('click', () => act(buttons.tts.textContent === t('tts.stop') ? 'TTS_STOP' : 'TTS_START'));

  chrome.runtime.onMessage.addListener((message: StateChangedMessage, sender) => {
    if (sender.id === chrome.runtime.id && message?.type === 'STATE_CHANGED' && sender.tab?.id === tab?.id) render(message.state);
  });

  const privacy = $('privacy');
  const main = $('main');
  const showMain = async () => {
    privacy.hidden = true;
    main.hidden = false;
    if (isRestrictedUrl(tab?.url)) return setDisabled(t('error.restricted'));
    if (tab?.url && isSiteDisabled(settings, new URL(tab.url).hostname)) return setDisabled(t('error.siteDisabled'));
    await send('GET_STATE', false);
  };

  if (settings.privacyAcknowledged) return showMain();
  privacy.hidden = false;
  $('ack-privacy').addEventListener('click', async () => {
    await saveSettings({ privacyAcknowledged: true });
    await showMain();
  });
}

void init();
