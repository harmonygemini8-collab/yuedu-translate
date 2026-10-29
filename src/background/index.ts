import {
  isEngine,
  isRestrictedUrl,
  isSingleWord,
  isValidLookup,
  isValidSegments,
  isValidSpeak,
  type ContentRequest,
  type LookupEntry,
  type LookupRequest,
  type LookupResponse,
  type SegmentResult,
  type SpeakResponse,
  type TranslateBatchRequest,
  type TranslateBatchResponse,
} from '../shared/messages';
import { API_BASE, effectiveEngine, loadAuthToken, loadCustomKey } from '../shared/api';
import { lookupWithCustom, translateWithCustom } from './custom-engine';
import { ALL_SITES_ORIGINS, autoScriptMatches, isTargetLang, loadSettings, siteOrigins, type EngineChoice } from '../shared/settings';
import { createTranslator, resolveUiLang } from '../shared/i18n';
import { translateWithGoogleFree } from './google-free';
import { translateWithFallback } from './engines';
import { translateCached } from './cache';
import { idbCache } from '../shared/idb-cache';
import { VOCAB_KEY, updateVocabBadge } from '../shared/vocab';
import { PlatformError, lookupViaPlatform, speakViaPlatform, translateViaPlatform } from './platform-provider';

const MENU_ID = 'yilin-toggle';

function isValidBatch(msg: unknown): msg is TranslateBatchRequest {
  const m = msg as Partial<TranslateBatchRequest> | null;
  return !!m && m.type === 'TRANSLATE_BATCH' && isTargetLang(m.targetLang) && isValidSegments(m.segments);
}

async function translate({ segments, targetLang }: TranslateBatchRequest): Promise<SegmentResult[]> {
  // The engine comes from the extension's own settings, never from the page-facing request.
  const settings = await loadSettings();
  const engine = effectiveEngine(settings.engine);
  const own = engine === 'custom';
  // The reader's own service is never fallen back from: they chose it for where their text goes.
  const cacheName = own ? `custom|${settings.customBaseUrl}|${settings.customModel}` : engine;
  // A fallback may answer with a different free engine than the one requested; the cache must remember that one,
  // or a later request under the requested engine's own name would wrongly return the fallback's words.
  const usedBy = new Map<string, EngineChoice>();
  return translateCached(
    segments,
    cacheName,
    targetLang,
    settings.translationCache ? idbCache : null,
    (missing) =>
      translateWithFallback(engine, missing, targetLang, settings.engineFallback && !own, {
        run: async (engine, batch, lang) =>
          engine === 'google-free'
            ? translateWithGoogleFree(batch, lang)
            : engine === 'custom'
              ? translateWithCustom(batch, lang, { baseUrl: settings.customBaseUrl, model: settings.customModel, key: await loadCustomKey() })
              : isEngine(engine)
                ? translateViaPlatform({ apiBase: API_BASE, token: await loadAuthToken(), engine, targetLang: lang, segments: batch })
                : Promise.reject(new PlatformError('NOT_CONFIGURED')),
        signedIn: async () => API_BASE !== '' && (await loadAuthToken()) !== '',
        errorCode: (err) => (err instanceof PlatformError ? err.code : 'PROVIDER_UNAVAILABLE'),
        onUsed: (id, used) => usedBy.set(id, used),
      }),
    (id) => usedBy.get(id) ?? engine,
  );
}

/**
 * Selection lookup (doc/03 FR-15). A single word goes to the model for a dictionary entry —
 * phonetics, senses, and what it means in this sentence — which is VIP-only. Everything else,
 * and every free account, gets the plain translation from the engine the user already chose,
 * so the bubble always has something to show.
 */
async function lookup({ text, context, targetLang }: LookupRequest): Promise<LookupEntry> {
  const trimmed = text.trim();
  const settings = await loadSettings();
  if (isSingleWord(trimmed) && effectiveEngine(settings.engine) === 'custom') {
    // The reader's own service gives the whole dictionary entry, with no plan needed; our server is not asked.
    try {
      return await lookupWithCustom(trimmed, context, targetLang, { baseUrl: settings.customBaseUrl, model: settings.customModel, key: await loadCustomKey() });
    } catch {
      // The plain translation below, from the same service.
    }
  } else if (isSingleWord(trimmed)) {
    try {
      return await lookupViaPlatform({ apiBase: API_BASE, token: await loadAuthToken(), targetLang, text: trimmed, context });
    } catch (err) {
      // No account, no VIP plan or no backend: fall through to the plain translation below.
      const code = err instanceof PlatformError ? err.code : 'PROVIDER_UNAVAILABLE';
      if (!['UNAUTHENTICATED', 'PLAN_REQUIRED', 'NOT_CONFIGURED', 'QUOTA_EXCEEDED'].includes(code)) throw err;
    }
  }
  const [result] = await translate({ type: 'TRANSLATE_BATCH', targetLang, segments: [{ id: 'selection', text: trimmed }] });
  if (!result?.ok) throw new PlatformError(result && !result.ok ? result.error : 'PROVIDER_UNAVAILABLE');
  return { text: trimmed, translation: result.text, source: 'engine' };
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse: (r: LookupResponse) => void) => {
  if ((message as { type?: unknown } | null)?.type !== 'LOOKUP') return;
  if (sender.id !== chrome.runtime.id || !sender.tab) return;
  if (!isValidLookup(message)) {
    sendResponse({ ok: false, error: 'INVALID_REQUEST' });
    return;
  }
  lookup(message)
    .then((entry) => sendResponse({ ok: true, entry }))
    .catch((err) => sendResponse({ ok: false, error: err instanceof PlatformError ? err.code : 'PROVIDER_UNAVAILABLE' }));
  return true;
});

// What a page script reports about itself (does it run here, and does it want to show its button), so a
// device that is only reachable through about:debugging can be diagnosed from this one console.
chrome.runtime.onMessage.addListener((message: unknown, sender) => {
  const note = message as { type?: unknown; detail?: unknown } | null;
  if (note?.type !== 'DIAG' || sender.id !== chrome.runtime.id || !sender.tab) return;
  console.info('[yuedu] page script', JSON.stringify(note.detail));
});

// A frame that loads after the page was translated (a chart in an iframe, shown only when scrolled to) never
// saw the command. It reports in, and if the top frame is translating, the frame is told to start too.
chrome.runtime.onMessage.addListener((message: unknown, sender) => {
  if ((message as { type?: unknown } | null)?.type !== 'FRAME_READY') return;
  const tabId = sender.tab?.id;
  if (sender.id !== chrome.runtime.id || tabId === undefined || !sender.frameId) return;
  void (async () => {
    const top = (await chrome.tabs.sendMessage(tabId, { type: 'GET_STATE' }, { frameId: 0 })) as { ok?: boolean; state?: { status?: string } } | undefined;
    if (top?.ok && (top.state?.status === 'translating' || top.state?.status === 'done')) {
      await chrome.tabs.sendMessage(tabId, { type: 'START' }, { frameId: sender.frameId });
    }
  })().catch(() => {});
});

// Video subtitles read the caption file the player downloads, which only the page's own JavaScript
// world can see; the content script cannot inject there itself (FR-19).
chrome.runtime.onMessage.addListener((message: unknown, sender) => {
  if ((message as { type?: unknown } | null)?.type !== 'CAPTION_HOOK') return;
  if (sender.id !== chrome.runtime.id || sender.tab?.id === undefined) return;
  void chrome.scripting
    .executeScript({ target: { tabId: sender.tab.id, frameIds: [sender.frameId ?? 0] }, world: 'MAIN', files: ['caption-hook.js'] })
    .catch(() => {});
});

/** Messages carry JSON, so the MP3 travels as base64 in pieces small enough for String.fromCharCode. */
function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

// Reading aloud with the platform's neural voice (doc/03 FR-16); the reader falls back to the browser's own voice on any error.
chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse: (r: SpeakResponse) => void) => {
  if ((message as { type?: unknown } | null)?.type !== 'SPEAK') return;
  if (sender.id !== chrome.runtime.id || !sender.tab) return;
  if (!isValidSpeak(message)) {
    sendResponse({ ok: false, error: 'INVALID_REQUEST' });
    return;
  }
  // With the reader's own service chosen, the text is not sent to our server for a voice either: the browser's own voice reads it.
  loadSettings()
    .then(async (settings) => {
      if (effectiveEngine(settings.engine) === 'custom') throw new PlatformError('NOT_CONFIGURED');
      return loadAuthToken();
    })
    .then((token) => speakViaPlatform({ apiBase: API_BASE, token, lang: message.lang, text: message.text }))
    .then((audio) => sendResponse({ ok: true, audio: toBase64(audio) }))
    .catch((err) => sendResponse({ ok: false, error: err instanceof PlatformError ? err.code : 'PROVIDER_UNAVAILABLE' }));
  return true;
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse: (r: TranslateBatchResponse) => void) => {
  if ((message as { type?: unknown } | null)?.type !== 'TRANSLATE_BATCH') return;
  // Only our own content scripts running in a tab may request translations.
  if (sender.id !== chrome.runtime.id || !sender.tab) return;
  if (!isValidBatch(message)) {
    sendResponse({ ok: false, error: 'INVALID_REQUEST' });
    return;
  }
  translate(message)
    .then((results) => sendResponse({ ok: true, results }))
    .catch((err) => sendResponse({ ok: false, error: err instanceof PlatformError ? err.code : 'PROVIDER_UNAVAILABLE' }));
  return true;
});

async function toggle(tab: chrome.tabs.Tab | undefined) {
  if (!tab?.id || isRestrictedUrl(tab.url)) return;
  const settings = await loadSettings();
  if (!settings.privacyAcknowledged) {
    await chrome.runtime.openOptionsPage();
    return;
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['content.js'] });
    const request: ContentRequest = { type: 'TOGGLE' };
    // No frameId: an embedded document viewer keeps its text in a child frame, which needs the
    // command too. Only the top frame replies.
    await chrome.tabs.sendMessage(tab.id, request);
  } catch {
    // Pages the browser refuses to script (e.g. other extensions, error pages) are skipped silently.
  }
}

async function menuTitle() {
  return createTranslator(resolveUiLang((await loadSettings()).uiLang))('menu.toggle');
}

const AUTO_SCRIPT_ID = 'yilin-auto';

/**
 * Startup, a settings change and a permission being granted or withdrawn can all ask for a sync,
 * and several of them arrive together when the user grants access to a site. Two runs overlapping
 * would both read the old registration and then both add or both remove it, which Chrome rejects
 * with "Duplicate script ID" / "Nonexistent script ID" and leaves nothing registered. Runs are
 * therefore queued one after another; a failed run must not stop the next one.
 */
let syncQueue: Promise<void> = Promise.resolve();

function syncAutoTranslateScripts(): Promise<void> {
  syncQueue = syncQueue.then(runAutoTranslateSync, runAutoTranslateSync);
  return syncQueue;
}

/**
 * Registers the content script ahead of any click: on every page when the user has allowed all sites
 * (so selection lookup works everywhere), otherwise on the sites on the auto-translate list, where it can
 * also start translating. Only sites whose host permission is actually
 * granted are registered: the user may decline the prompt, or withdraw the permission later.
 */
async function runAutoTranslateSync(): Promise<void> {
  const { autoTranslateSites } = await loadSettings();
  const allowed = await Promise.all(
    autoTranslateSites.map(async (site) => ((await chrome.permissions.contains({ origins: siteOrigins(site) })) ? site : null)),
  );
  const allSites = await chrome.permissions.contains({ origins: ALL_SITES_ORIGINS });
  const matches = autoScriptMatches(allSites, allowed.filter((site) => site !== null));
  const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [AUTO_SCRIPT_ID] });
  if (registered.length > 0) {
    // Another context may have removed it between the read and here.
    await chrome.scripting.unregisterContentScripts({ ids: [AUTO_SCRIPT_ID] }).catch(() => {});
  }
  if (matches.length === 0) return;
  // Same the other way round: if the id somehow survived, replace it rather than fail.
  const script = { id: AUTO_SCRIPT_ID, matches, js: ['content.js'], runAt: 'document_idle' as const, allFrames: true };
  // Said out loud, because a failure here is otherwise invisible: the floating button simply
  // never shows up on later pages (seen on Firefox for Android, doc/14 §10.4).
  await chrome.scripting
    .registerContentScripts([script])
    .catch(() => chrome.scripting.updateContentScripts([script]))
    .then(() => console.info('[yuedu] content script registered for', matches))
    .catch((err) => console.error('[yuedu] registering the content script failed', matches, err));
}

chrome.runtime.onInstalled.addListener(async () => {
  // Firefox for Android has no context menus and no keyboard commands; the rest of the extension works without them.
  if (chrome.contextMenus) chrome.contextMenus.create({ id: MENU_ID, title: await menuTitle(), contexts: ['page', 'selection'] });
});

// `onInstalled`/`onStartup` only cover a fresh install and the browser's own startup; they miss
// the far more common case of this background script itself being torn down and respawned —
// normal MV3 service-worker behaviour, and especially frequent on Android, where the OS kills
// background pages to free memory. Firefox does not re-fire either event for that, so a
// registration made only inside them is lost the first time the script is evicted: the floating
// button then stops appearing on freshly opened or back-navigated pages until something else
// (e.g. the popup's own click) happens to wake the script, and even then only that one page gets
// scripted, imperatively, not the standing registration. Calling it unconditionally here means
// every single time this module runs — install, browser start, or an ordinary respawn — puts the
// registration back (doc/14 §10.4).
void syncAutoTranslateScripts();
chrome.runtime.onStartup.addListener(() => void syncAutoTranslateScripts());
chrome.permissions.onAdded.addListener(() => void syncAutoTranslateScripts());
chrome.permissions.onRemoved.addListener(() => void syncAutoTranslateScripts());

// Keep the right-click menu in the chosen interface language.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  if ('uiLang' in changes && chrome.contextMenus) chrome.contextMenus.update(MENU_ID, { title: await menuTitle() });
  if ('autoTranslateSites' in changes) await syncAutoTranslateScripts();
  // The toolbar badge shows how many due words are waiting; whatever wrote the word book may have changed that count.
  if (VOCAB_KEY in changes) void updateVocabBadge();
});
// Same reasoning as the content-script registration above: this has to run on every load, not just on
// install/startup, because a respawned service worker is the common case and the badge must not go stale.
void updateVocabBadge();

chrome.contextMenus?.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_ID) void toggle(tab);
});

chrome.commands?.onCommand.addListener((command, tab) => {
  if (command === 'toggle-translation') void toggle(tab);
});
