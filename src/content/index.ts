import {
  isContentRequest,
  type ContentRequest,
  type ContentResponse,
  type PageState,
  type SpeakRequest,
  type SpeakResponse,
  type StateChangedMessage,
  type LookupRequest,
  type LookupResponse,
  type SegmentInput,
  type CaptionHookRequest,
  type DiagnosticMessage,
  type TranslateBatchRequest,
  type TranslateBatchResponse,
} from '../shared/messages';
import { IS_PUBLIC } from '../shared/api';
import { isAutoTranslateSite, isSiteDisabled, loadSettings, pageIsInTargetLanguage, sanitizeSettings, saveSettings, type Settings, type TargetLang } from '../shared/settings';
import { TranslationController } from './controller';
import { hasWord, pageOf, saveWord } from '../shared/vocab';
import { createInputTranslate } from './input-translate';
import { createFloatingButton, type FloatingState } from './floating';
import { ArticleReader } from './tts';
import { createSelectionLookup } from './selection';
import { SubtitleTranslator } from './subtitles';
import { createYoutubeMenu, isYoutubeHost, type YoutubeMenu } from './youtube-menu';
import { createVideoBadge, type VideoBadge } from './video-badge';

interface YilinInstance {
  /** False once the extension was reloaded/updated and this script lost its connection. */
  alive(): boolean;
  /** Remove everything this instance added to the page and stop all work. */
  dispose(): void;
  /** Development builds only: per-paragraph state, for diagnosing a page that will not translate. */
  inspect?(): unknown;
}

declare global {
  interface Window {
    __yilin?: YilinInstance;
  }
}

/** Below this, on either side, a frame is a tracking pixel or a widget rather than something to read. */
const MIN_FRAME_SIDE = 200;
const isTopFrame = window.self === window.top;

/**
 * An embedded document viewer renders its text in a child frame, so running only in the top
 * document leaves exactly the part the reader came for untranslated. Running in every frame
 * instead would start up inside ad and tracking frames too, so a sub-frame has to be large
 * enough to hold prose before it counts.
 */
function frameIsWorthTranslating(): boolean {
  return isTopFrame || (window.innerWidth >= MIN_FRAME_SIDE && window.innerHeight >= MIN_FRAME_SIDE);
}

function init(): YilinInstance {
  // Keep a reference to this instance's runtime: after an extension reload its `id`
  // becomes undefined, which is how an orphaned content script can recognise itself.
  const runtime = chrome.runtime;
  const alive = () => {
    try {
      return !!runtime?.id;
    } catch {
      return false;
    }
  };
  // Development builds only: a store build says nothing about the pages it runs on.
  const diag = (event: string, extra: Record<string, string | number | boolean> = {}) => {
    if (IS_PUBLIC || !alive()) return;
    const message: DiagnosticMessage = { type: 'DIAG', detail: { event, host: location.hostname, top: isTopFrame, ...extra } };
    runtime.sendMessage(message).catch(() => {});
  };
  diag('started');
  let controller: TranslationController | undefined;
  let selection: ReturnType<typeof createSelectionLookup> | undefined;
  let subtitles: SubtitleTranslator | undefined;
  let youtube: YoutubeMenu | undefined;
  let videoBadge: VideoBadge | undefined;

  let floating: ReturnType<typeof createFloatingButton> | undefined;
  let inputTranslate: ReturnType<typeof createInputTranslate> | undefined;
  let latestSettings: Settings | undefined;
  const FLOATING_TOP_KEY = 'floatingTop';
  const SUBTITLE_OFFSET_KEY = 'subtitleOffset';

  const floatingState = (state: PageState): FloatingState => ({
    status: state.status,
    translated: state.translated,
    speaking: reader.active,
    displayMode: latestSettings?.displayMode ?? 'bilingual',
  });

  /** Top frame only; `auto` means touch devices, which have no shortcut, right-click menu or hover. */
  const wantsFloating = (s: Settings) =>
    isTopFrame
    && !isSiteDisabled(s, location.hostname)
    && (s.floatingButton === 'on' || (s.floatingButton === 'auto' && window.matchMedia?.('(pointer: coarse)').matches === true));

  async function syncFloating(settings: Settings) {
    latestSettings = settings;
    diag('floating', {
      setting: settings.floatingButton,
      coarse: window.matchMedia?.('(pointer: coarse)').matches === true,
      disabled: isSiteDisabled(settings, location.hostname),
      wants: wantsFloating(settings),
    });
    if (!wantsFloating(settings)) {
      floating?.dispose();
      floating = undefined;
      return;
    }
    if (floating) {
      floating.updateSettings(settings);
      if (controller) floating.update(floatingState(controller.getState()));
      return;
    }
    const saved = (await chrome.storage.local.get(FLOATING_TOP_KEY))[FLOATING_TOP_KEY];
    if (floating || !alive()) return;
    floating = createFloatingButton(document, {
      settings,
      top: typeof saved === 'number' ? saved : null,
      saveTop: (top) => void chrome.storage.local.set({ [FLOATING_TOP_KEY]: top }),
      actions: {
        toggle: () => void handle({ type: 'TOGGLE' }),
        toggleRead: () => (reader.active ? reader.stop('floating button') : reader.start()),
        toggleMode: () => void saveSettings({ displayMode: latestSettings?.displayMode === 'translation' ? 'bilingual' : 'translation' }),
      },
    });
    if (controller) floating.update(floatingState(controller.getState()));
    diag('floating created', { attached: document.getElementById('yilin-floating') !== null });
  }

  function pushState(state: PageState) {
    floating?.update(floatingState(state));
    if (!alive()) return;
    const message: StateChangedMessage = { type: 'STATE_CHANGED', state: { ...state, speaking: reader.active } };
    // The popup may be closed; nobody listening is fine.
    runtime.sendMessage(message).catch(() => {});
  }
  let remoteError = '';
  const reader = new ArticleReader(document, {
    // The settings switch is for development builds; a store build ignores it (the console switch still works).
    debug: () => !IS_PUBLIC && latestSettings?.debugReading === true,
    prepare: (root) => controller?.translateWithin(root),
    remoteError: () => remoteError,
    // The platform's neural voice, for browsers with no good voice of their own. Null means "use the local one".
    speakRemote: async (text, lang) => {
      if (!alive()) {
        remoteError = 'extension reloaded';
        return null;
      }
      const request: SpeakRequest = { type: 'SPEAK', lang: lang as TargetLang, text };
      const response = (await runtime.sendMessage(request).catch(() => undefined)) as SpeakResponse | undefined;
      if (!response?.ok) {
        remoteError = response ? response.error : 'no answer from the extension';
        return null;
      }
      remoteError = '';
      const binary = atob(response.audio);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes.buffer;
    },
    isTranslating: () => controller?.getState().status === 'translating',
    onChange: () => controller && pushState(controller.getState()),
  });

  const ready = loadSettings().then(async (settings) => {
    selection = createSelectionLookup(document, {
      settings,
      save: (entry, context) =>
        saveWord({ text: entry.text, translation: entry.translation, phonetic: entry.phonetic, senses: entry.senses, context, sourceLang: entry.sourceLang, page: pageOf(location.href) }),
      isSaved: hasWord,
      lookup: async (text, context, targetLang) => {
        if (!alive()) throw new Error('Extension context invalidated');
        const request: LookupRequest = { type: 'LOOKUP', targetLang, text, context };
        const response = (await runtime.sendMessage(request)) as LookupResponse | undefined;
        if (!response) throw new Error('NETWORK');
        if (!response.ok) throw new Error(response.error);
        return response.entry;
      },
    });
    const translate = async (segments: SegmentInput[], targetLang: TargetLang) => {
      if (!alive()) throw new Error('Extension context invalidated');
      const request: TranslateBatchRequest = { type: 'TRANSLATE_BATCH', targetLang, segments };
      const response = (await runtime.sendMessage(request)) as TranslateBatchResponse | undefined;
      if (!response) throw new Error('No response');
      return response.ok ? response.results : segments.map((s) => ({ id: s.id, ok: false as const, error: response.error }));
    };
    inputTranslate = createInputTranslate(document, { settings, translate });
    controller = new TranslationController(document, { settings, translate, onState: pushState });
    // Subtitles ride along with the page: a video is read through the same translation service
    // and stops when the reader asks for the original back (FR-19). Where the viewer dragged the
    // block is remembered the same way the floating button's position is.
    const stored = (await chrome.storage.local.get(SUBTITLE_OFFSET_KEY).catch(() => ({}))) as Record<string, unknown>;
    const savedOffset = stored[SUBTITLE_OFFSET_KEY] as { x?: unknown; y?: unknown } | undefined;
    subtitles = new SubtitleTranslator(document, {
      translate,
      settings,
      offset: typeof savedOffset?.x === 'number' && typeof savedOffset?.y === 'number' ? { x: savedOffset.x, y: savedOffset.y } : undefined,
      onOffsetChange: (offset) => void chrome.storage.local.set({ [SUBTITLE_OFFSET_KEY]: offset }),
      onActiveChange: () => {
        youtube?.refresh();
        videoBadge?.refresh();
      },
      injectHook: () => {
        if (!alive()) return;
        const request: CaptionHookRequest = { type: 'CAPTION_HOOK' };
        void runtime.sendMessage(request).catch(() => {});
      },
    });
    // Sites on the auto-translate list start on their own unless the page already is in the target
    // language. Starting a page with nothing to translate costs nothing: the extractor skips text
    // already in the target language, and the controller then just watches for content arriving later.
    if (
      isAutoTranslateSite(settings, location.hostname)
      && !isSiteDisabled(settings, location.hostname)
      && !pageIsInTargetLanguage(document.documentElement.lang, settings.targetLang)
    ) {
      controller.start();
      subtitles.start();
    }
    void syncFloating(settings);
    // YouTube: our own button in the player's control bar, to start subtitle translation in one click.
    if (isYoutubeHost(location.hostname) && !isSiteDisabled(settings, location.hostname)) {
      youtube = createYoutubeMenu({
        doc: document,
        getSettings: () => latestSettings ?? settings,
        isActive: () => subtitles?.running ?? false,
        setActive: (on) => (on ? subtitles?.start() : subtitles?.stop()),
        setSettings: (patch) => void saveSettings(patch),
        resetPosition: () => subtitles?.resetPosition(),
      });
    }
    // Everywhere else the player's controls are its own, so a badge floats over a video that has subtitles.
    if (!isYoutubeHost(location.hostname) && !isSiteDisabled(settings, location.hostname)) {
      videoBadge = createVideoBadge({
        doc: document,
        getSettings: () => latestSettings ?? settings,
        isActive: () => subtitles?.running ?? false,
        setActive: (on) => (on ? subtitles?.start() : subtitles?.stop()),
        setSettings: (patch) => void saveSettings(patch),
        resetPosition: () => subtitles?.resetPosition(),
        hasSource: (video) => subtitles?.hasSource(video) ?? false,
      });
    }
    return controller;
  });

  chrome.storage.onChanged.addListener(async (_changes, area) => {
    if (area !== 'local' || !alive()) return;
    const [ctrl, values] = await Promise.all([ready, chrome.storage.local.get(null)]);
    const next = sanitizeSettings(values);
    ctrl.updateSettings(next);
    selection?.updateSettings(next);
    inputTranslate?.updateSettings(next);
    subtitles?.updateSettings(next);
    void syncFloating(next);
    youtube?.refresh();
    videoBadge?.refresh();
  });

  async function handle({ type }: ContentRequest): Promise<ContentResponse> {
    const ctrl = await ready;
    const settings = sanitizeSettings(await chrome.storage.local.get(null));
    const disabled = isSiteDisabled(settings, location.hostname);
    const wantsStart = type === 'START' || (type === 'TOGGLE' && ctrl.getState().status === 'idle');
    if (wantsStart && disabled) return { ok: false, error: 'SITE_DISABLED' };

    if (type === 'START' || (type === 'TOGGLE' && wantsStart)) {
      ctrl.start();
      subtitles?.start();
    } else if (type === 'TOGGLE' || type === 'RESTORE') {
      reader.stop(`command ${type}`);
      subtitles?.stop();
      ctrl.restore();
    } else if (type === 'STOP') {
      subtitles?.stop();
      ctrl.stop();
    }
    else if (type === 'RETRY_FAILED') ctrl.retryFailed();
    else if (type === 'TTS_START') reader.start();
    else if (type === 'TTS_STOP') reader.stop('popup button');
    return { ok: true, state: { ...ctrl.getState(), speaking: reader.active } };
  }

  // Development builds: the page console cannot reach this isolated world, so an event in the page
  // asks for the per-paragraph state and the answer is left on the document for it to read.
  if (!IS_PUBLIC) {
    document.addEventListener('yilin-inspect', () => {
      const report = { paragraphs: controller?.inspect() ?? 'not started', subtitles: subtitles?.inspect() ?? 'not started' };
      document.documentElement.setAttribute('data-yilin-debug', JSON.stringify(report));
    });
  }

  runtime.onMessage.addListener((message: unknown, sender, sendResponse: (r: ContentResponse) => void) => {
    if (sender.id !== runtime.id || sender.tab || !isContentRequest(message)) return;
    // Every frame acts on the command, so an embedded document translates along with the page
    // around it, but only the top frame answers: the popup needs one state, and a second frame
    // calling sendResponse would race it.
    void handle(message).then((response) => {
      if (isTopFrame) sendResponse(response);
    });
    return isTopFrame;
  });

  // A frame that appears after the page was translated (a chart or document viewer loaded lazily) missed the
  // command; the background tells it to join if the page around it is being translated.
  if (!isTopFrame) void ready.then(() => runtime.sendMessage({ type: 'FRAME_READY' }).catch(() => {}));

  return {
    alive,
    dispose: () => {
      reader.stop('dispose');
      subtitles?.stop();
      youtube?.destroy();
      videoBadge?.destroy();
      floating?.dispose();
      selection?.dispose();
      inputTranslate?.dispose();
      controller?.restore();
    },
    ...(IS_PUBLIC ? {} : { inspect: () => ({ paragraphs: controller?.inspect() ?? 'not started', subtitles: subtitles?.inspect() ?? 'not started' }) }),
  };
}

// The background and popup inject this file on demand, possibly many times.
// Reuse a live instance; replace one orphaned by an extension reload or update.
const existing = window.__yilin;
if (frameIsWorthTranslating() && !existing?.alive()) {
  try {
    existing?.dispose();
  } catch {
    // The old instance is already broken; its DOM nodes are cleaned up by the new one below.
  }
  document.querySelectorAll('[data-yilin="translation"], [data-yilin="selection"], [data-yilin="floating"], [data-yilin="subtitle"], #yilin-translate-style, #yilin-subtitle-style').forEach((n) => n.remove());
  document.querySelectorAll('[data-yilin-id]').forEach((n) => n.removeAttribute('data-yilin-id'));
  window.__yilin = init();
}
