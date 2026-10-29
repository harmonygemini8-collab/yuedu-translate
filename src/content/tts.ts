import { buildStamp, extensionVersion } from '../shared/links';
import { collectReadableNodes, readableRoot, translatedBodyNodes } from './reader';

/** Short pieces: Chrome's online voices tend to cut off a long utterance after about 15 seconds. */
export function splitForSpeech(text: string, max = 160): string[] {
  const sentences = text.split(/(?<=[。！？!?；;])\s*|(?<=\.\s)/).filter((s) => s.trim() !== '');
  const out: string[] = [];
  let current = '';
  for (const s of sentences) {
    if (current && current.length + s.length > max) {
      out.push(current.trim());
      current = '';
    }
    current += s;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/** Edge, Windows 11 and macOS ship neural voices whose names say so. */
export const isNaturalVoice = (voice: SpeechSynthesisVoice) => /natural|neural|online|premium|enhanced/i.test(voice.name);

/** Prefer neural/natural voices (Edge, Windows 11, macOS enhanced) over the plain system voice. */
export function pickVoice(voices: SpeechSynthesisVoice[], lang: string): SpeechSynthesisVoice | undefined {
  const want = lang.toLowerCase();
  const norm = (v: SpeechSynthesisVoice) => v.lang.toLowerCase().replace('_', '-');
  const exact = voices.filter((v) => norm(v) === want || (want === 'zh-hk' && norm(v).startsWith('yue')));
  const pool = exact.length > 0 ? exact : voices.filter((v) => norm(v).startsWith(want.split('-')[0]!));
  const score = (v: SpeechSynthesisVoice) => (isNaturalVoice(v) ? 3 : 0) + (/google/i.test(v.name) ? 1 : 0);
  return [...pool].sort((a, b) => score(b) - score(a))[0];
}

/**
 * Whether to ask the server for a neural voice. A browser that already has one (Edge) reads with it:
 * free, no network round trip and nothing counted against the account. Only a browser without one
 * (Chrome, Firefox) needs the server.
 */
export const wantsRemoteVoice = (voices: SpeechSynthesisVoice[], lang: string) => {
  const best = pickVoice(voices, lang);
  return !(best && isNaturalVoice(best));
};

export interface ArticleReaderOptions {
  /** Whether more translations may still arrive, so the reader should wait for them at the end. */
  isTranslating(): boolean;
  /** Reading started or stopped. */
  onChange(): void;
  /** MP3 from the platform's neural voice, or null when it is not available (signed out, over quota, offline). */
  speakRemote?(text: string, lang: string): Promise<ArrayBuffer | null>;
  /** How long to let the page translate after scrolling on, in milliseconds. Tests shorten it. */
  settleMs?: number;
  /** How long a person's own scrolling keeps the reader from moving the page, in milliseconds. Tests shorten it. */
  userPauseMs?: number;
  /** Called when reading starts on a touch device, so the rest of the article can be translated before the screen turns off. */
  prepare?(root: Element): void;
  /** The settings switch for the diagnostics trace. */
  debug?(): boolean;
  /** Why the server's voice was not available last time (signed out, over quota, offline), for the trace. */
  remoteError?(): string;
}

const IDLE_LIMIT_MS = 20_000;
const VOICES_WAIT_MS = 400;
/** Chrome keeps a page's audio suspended until the person has interacted with it; do not wait on that. */
const RESUME_WAIT_MS = 600;
const PREFETCH_AHEAD = 2;
const SETTLE_MS = 1200;
/** A paragraph inside this band of the screen is already comfortably in view and is not scrolled to. */
const BAND_TOP = 0.12;
const BAND_BOTTOM = 0.88;
/** Where a followed paragraph lands, as a share of the screen height from the top. */
const LAND_AT = '28vh';
/** One step down the article, as a share of the screen. */
const ADVANCE_FRACTION = 0.85;
const BOTTOM_SLACK_PX = 40;
/** A person scrolling or typing keeps the page to themselves for this long. */
const USER_PAUSE_MS = 4000;
/** A feed that never ends must not be read forever. */
const MAX_ADVANCES = 80;
/** Times one sentence may be cut off and said again; a person locking and unlocking now and then stays well under it. */
const MAX_RESUMES = 20;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * One second of 16-bit mono PCM whose samples alternate between 0 and 1: far below hearing, but not digital
 * silence, which a browser may decide is not playing at all. Looped under the reading, it is what lets a phone
 * keep the page alive with the screen off.
 */
function quietClip(): Blob {
  const rate = 8000;
  const bytes = rate * 2;
  const buffer = new ArrayBuffer(44 + bytes);
  const view = new DataView(buffer);
  const text = (at: number, value: string) => [...value].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + bytes, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, bytes, true);
  for (let i = 0; i < rate; i++) view.setInt16(44 + i * 2, i % 2, true);
  return new Blob([buffer], { type: 'audio/wav' });
}

/** Reads the article's translated paragraphs one after another, following translation as it arrives. */
export class ArticleReader {
  active = false;
  private token = 0;
  /** Held so the browser cannot garbage-collect an utterance before its end event fires. */
  private current: SpeechSynthesisUtterance | null = null;
  private audio: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  /** Server voice still in use for this reading; one failure ends it and the browser's own voice takes over. */
  private remoteOk = false;
  private fetching = new Map<string, Promise<ArrayBuffer | null>>();
  private userActiveAt = 0;
  /** What keeps the page playing media while the screen is off: a looped quiet clip and the media session. */
  private background: { audio: HTMLAudioElement; url: string } | null = null;
  /** The element the server's voice plays through; a media element, unlike Web Audio, survives the screen turning off. */
  private voice: HTMLAudioElement | null = null;
  /** The article being read, fixed when reading starts so scrolling on cannot lead into the next one. */
  private root: Element | null = null;
  private readonly onUser = () => {
    this.userActiveAt = Date.now();
  };

  /** Diagnostics for chasing a reading that stops on a real phone: off unless switched on, never leaves the page. */
  private debug = false;
  /** A touch screen: where the page can be frozen under the reading, so speech goes out in large pieces. */
  private touch = false;
  /** Set while waiting for the page to come back to the front. */
  private wake: (() => void) | null = null;
  private trace: string[] = [];
  private readonly onVisibility = () => {
    const synth = this.synth;
    this.note(`page ${this.doc.visibilityState}; speaking=${synth?.speaking} paused=${synth?.paused} active=${this.active}`);
    if (this.doc.visibilityState === 'visible') this.showTrace();
  };

  /** On from the settings page, or with `localStorage.yilinDebug = '1'` in the page console. */
  private debugEnabled(): boolean {
    if (this.options.debug?.()) return true;
    try {
      const view = this.doc.defaultView;
      if (view?.location.hash.includes('yilinDebug')) view.localStorage.setItem('yilinDebug', '1');
      return view?.localStorage.getItem('yilinDebug') === '1';
    } catch {
      return false;
    }
  }

  private note(message: string) {
    if (!this.debug) return;
    const now = new Date();
    const stamp = `${now.toTimeString().slice(0, 8)}.${String(now.getMilliseconds()).padStart(3, '0')}`;
    this.trace.push(`${stamp} ${message}`);
    if (this.trace.length > 300) this.trace.shift();
  }

  /** Shown when the page comes back to the front, so a reading done with the screen off can be inspected. */
  private showTrace() {
    if (!this.debug || this.trace.length === 0) return;
    this.doc.getElementById('yilin-trace')?.remove();
    const host = this.doc.createElement('div');
    host.id = 'yilin-trace';
    host.setAttribute('data-yilin', 'trace');
    const shadow = host.attachShadow({ mode: 'open' });
    const box = this.doc.createElement('div');
    box.style.cssText = 'position:fixed;z-index:2147483647;left:8px;right:8px;bottom:8px;max-height:45vh;overflow:auto;background:#111;color:#cfe;font:11px/1.45 monospace;padding:8px;border-radius:8px;white-space:pre-wrap;word-break:break-all';
    const close = this.doc.createElement('button');
    close.textContent = 'Close';
    close.style.cssText = 'display:block;margin-bottom:6px;padding:6px 12px';
    close.addEventListener('click', () => {
      this.trace = [];
      host.remove();
    });
    const log = this.doc.createElement('div');
    log.textContent = this.trace.join('\n');
    box.append(close, log);
    shadow.append(box);
    this.doc.documentElement.append(host);
  }

  constructor(private readonly doc: Document, private readonly options: ArticleReaderOptions) {}

  private get synth(): SpeechSynthesis | undefined {
    return typeof speechSynthesis === 'undefined' ? undefined : speechSynthesis;
  }

  /** Starts at the first paragraph that is not scrolled out of view above. */
  start(): void {
    const synth = this.synth;
    if (!synth) return;
    synth.cancel();
    this.source?.stop();
    // The article is the one the reader is looking at, found before the page is narrowed to it.
    const everything = translatedBodyNodes(this.doc);
    if (everything.length === 0) return;
    const onScreen = everything.find((n) => n.getBoundingClientRect().bottom > 0) ?? everything[0]!;
    this.root = readableRoot(this.doc, onScreen);
    const nodes = collectReadableNodes(this.doc, this.root);
    if (nodes.length === 0) return;
    const visible = nodes.findIndex((n) => n.getBoundingClientRect().bottom > 0);
    const token = ++this.token;
    this.active = true;
    this.remoteOk = !!this.options.speakRemote;
    this.fetching.clear();
    this.touch = this.doc.defaultView?.matchMedia?.('(pointer: coarse)').matches === true;
    this.debug = this.debugEnabled();
    if (this.debug) {
      this.trace = [];
      this.doc.removeEventListener('visibilitychange', this.onVisibility);
      this.doc.addEventListener('visibilitychange', this.onVisibility);
      this.note(`v${extensionVersion()} build ${buildStamp()}`);
      this.note(`start: nodes=${nodes.length} root=${this.root?.tagName ?? 'none'} voices=${synth.getVoices().length} remote=${this.remoteOk} page=${this.doc.visibilityState} touch=${this.touch} prefetch=${this.touch && !!this.root}`);
    }
    if (this.touch && this.root) this.options.prepare?.(this.root);
    this.watchUser();
    this.startBackground();
    this.options.onChange();
    void this.run(token, nodes, Math.max(visible, 0));
  }

  stop(reason = 'stop'): void {
    this.note(`stop(${reason}) active=${this.active}`);
    this.token++;
    this.synth?.cancel();
    this.source?.stop();
    this.fetching.clear();
    this.unwatchUser();
    this.stopBackground();
    this.voice?.pause();
    this.wake?.();
    if (this.active) {
      this.active = false;
      this.options.onChange();
    }
    if (this.doc.visibilityState === 'visible') this.showTrace();
  }

  /**
   * A phone freezes a page whose screen goes off, and speech stops with it. A page that is playing media, with a
   * media session on the lock screen, is left running. Nothing here is required: on a desktop, or where the
   * browser refuses (no user gesture yet), the reading simply carries on as before.
   */
  private startBackground() {
    try {
      const session = this.doc.defaultView?.navigator.mediaSession;
      if (session && typeof MediaMetadata !== 'undefined') {
        session.metadata = new MediaMetadata({ title: this.doc.title || 'Yuedu Translate', artist: 'Yuedu Translate' });
        session.playbackState = 'playing';
        session.setActionHandler('pause', () => this.stop('mediasession pause'));
        session.setActionHandler('stop', () => this.stop('mediasession stop'));
      }
      if (typeof Audio !== 'undefined' && typeof URL.createObjectURL === 'function' && !this.background) {
        const url = URL.createObjectURL(quietClip());
        const audio = new Audio(url);
        audio.loop = true;
        this.background = { audio, url };
        void Promise.resolve(audio.play()).catch(() => {});
      }
    } catch {
      // Best effort only.
    }
  }

  private stopBackground() {
    try {
      const session = this.doc.defaultView?.navigator.mediaSession;
      if (session) {
        session.playbackState = 'none';
        session.setActionHandler('pause', null);
        session.setActionHandler('stop', null);
        session.metadata = null;
      }
    } catch {
      // Best effort only.
    }
    if (this.background) {
      this.background.audio.pause();
      URL.revokeObjectURL(this.background.url);
      this.background = null;
    }
  }

  private watchUser() {
    this.userActiveAt = 0;
    for (const type of ['wheel', 'touchmove', 'keydown'] as const) this.doc.addEventListener(type, this.onUser, { passive: true, capture: true });
  }

  private unwatchUser() {
    for (const type of ['wheel', 'touchmove', 'keydown'] as const) this.doc.removeEventListener(type, this.onUser, { capture: true });
  }

  private userIsScrolling = () => Date.now() - this.userActiveAt < (this.options.userPauseMs ?? USER_PAUSE_MS);

  /** Brings the paragraph being read into view, unless it already is or the person is scrolling themselves. */
  private follow(node: HTMLElement) {
    if (this.userIsScrolling()) return;
    const height = this.doc.defaultView?.innerHeight;
    if (!height) return;
    const rect = node.getBoundingClientRect();
    if (rect.top >= height * BAND_TOP && rect.bottom <= height * BAND_BOTTOM) return;
    node.style.scrollMarginTop = LAND_AT;
    node.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }

  /** The nearest ancestor that scrolls on its own (a web app's article pane); null when the page itself scrolls. */
  private scrollParent(from: Element): HTMLElement | null {
    const view = this.doc.defaultView;
    for (let el = from.parentElement; el && el !== this.doc.body && el !== this.doc.documentElement; el = el.parentElement) {
      const overflow = view?.getComputedStyle(el).overflowY;
      if ((overflow === 'auto' || overflow === 'scroll') && el.scrollHeight > el.clientHeight + 1) return el;
    }
    return null;
  }

  /**
   * Everything translated has been read, but only the paragraphs near the screen get translated, so the rest
   * of this article is still waiting. Scroll on to bring it in, but only as far as the article's own end:
   * what lies below it is usually another article, and showing it would translate it too (and spend quota).
   * `bottom` means the article's end is on screen, or there is no article to measure against.
   */
  private advance(): 'scrolled' | 'wait' | 'bottom' {
    // A page in the background neither scrolls on screen nor translates what it scrolls past: the reading is done.
    if (this.doc.visibilityState === 'hidden') return 'bottom';
    if (this.userIsScrolling()) return 'wait';
    const view = this.doc.defaultView;
    const root = this.root;
    // Without an article landmark there is no end to stop at, so the page is not scrolled on its own.
    if (!view || !root) return 'bottom';
    // A main that holds several articles is a feed: its end is not this article's end.
    if (root.querySelectorAll('article').length > 1) return 'bottom';
    const pane = this.scrollParent(root);
    const viewBottom = pane ? pane.getBoundingClientRect().bottom : view.innerHeight;
    const viewHeight = pane ? pane.clientHeight : view.innerHeight;
    const toEnd = root.getBoundingClientRect().bottom - viewBottom;
    if (toEnd <= BOTTOM_SLACK_PX) return 'bottom';
    const top = Math.min(viewHeight * ADVANCE_FRACTION, toEnd);
    if (pane) pane.scrollBy?.({ top, behavior: 'smooth' });
    else view.scrollBy({ top, behavior: 'smooth' });
    return 'scrolled';
  }

  /** The voice list loads asynchronously; deciding before it is there would send Edge to the server. */
  private async voicesReady(): Promise<void> {
    const synth = this.synth;
    if (!synth || synth.getVoices().length > 0) return;
    await new Promise<void>((resolve) => {
      synth.addEventListener('voiceschanged', () => resolve(), { once: true });
      setTimeout(resolve, VOICES_WAIT_MS);
    });
  }

  private async run(token: number, initial: HTMLElement[], from: number): Promise<void> {
    await this.voicesReady();
    let nodes = initial;
    let i = from;
    let last: HTMLElement | undefined;
    let idleSince = 0;
    let advances = 0;
    while (token === this.token) {
      const node = nodes[i];
      if (!node) {
        // Reached the end of what is translated: carry on with paragraphs translated meanwhile.
        const fresh = collectReadableNodes(this.doc, this.root).filter(
          (n) => !last || (last.isConnected && last.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING),
        );
        if (fresh.length > 0) {
          nodes = fresh;
          i = 0;
          idleSince = 0;
          continue;
        }
        if (this.options.isTranslating()) {
          idleSince ||= Date.now();
          if (Date.now() - idleSince > IDLE_LIMIT_MS) {
            this.note('end: waited too long for translation');
            break;
          }
          await sleep(500);
          continue;
        }
        // Everything on screen is read: follow the article down so the paragraphs after it get translated.
        const next = this.advance();
        this.note(`advance -> ${next} (page ${this.doc.visibilityState})`);
        if (next === 'bottom' || advances >= MAX_ADVANCES) {
          this.note(`end: ${next === 'bottom' ? 'reached the end of the article' : 'too many scrolls'}`);
          break;
        }
        if (next === 'scrolled') advances++;
        idleSince = 0;
        await sleep(this.options.settleMs ?? SETTLE_MS);
        continue;
      }
      i++;
      if (!node.isConnected) continue;
      last = node;
      const lang = node.lang || 'zh-CN';
      this.note(`read ${i}/${nodes.length}: ${(node.textContent ?? '').trim().slice(0, 14)}`);
      this.follow(node);
      const chunks = splitForSpeech(node.textContent?.trim() ?? '');
      for (let c = 0; c < chunks.length; c++) {
        if (token !== this.token) return;
        // The pieces after this one are fetched while it plays, so the voice does not pause between sentences.
        const upcoming = chunks.slice(c + 1, c + 1 + PREFETCH_AHEAD);
        for (let n = i; upcoming.length < PREFETCH_AHEAD && nodes[n]; n++) {
          upcoming.push(...splitForSpeech(nodes[n]!.textContent?.trim() ?? '').slice(0, PREFETCH_AHEAD - upcoming.length));
        }
        await this.speak(chunks[c]!, lang, upcoming, token);
      }
    }
    if (token === this.token) {
      this.note('finished');
      this.unwatchUser();
      this.stopBackground();
      this.active = false;
      this.options.onChange();
      if (this.doc.visibilityState === 'visible') this.showTrace();
    } else {
      this.note('run left: stopped from outside');
    }
  }

  private fetchAudio(text: string, lang: string): Promise<ArrayBuffer | null> {
    const key = `${lang}\n${text}`;
    let pending = this.fetching.get(key);
    if (!pending) {
      pending = this.options.speakRemote!(text, lang).catch(() => null);
      this.fetching.set(key, pending);
    }
    return pending;
  }

  /** Whether this piece will go through the server's voice (which is played from a media element, one piece at a time). */
  private usesServerVoice(lang: string): boolean {
    const synth = this.synth;
    if (!synth || !this.remoteOk) return false;
    return wantsRemoteVoice(synth.getVoices(), lang === 'yue' ? 'zh-HK' : lang);
  }

  private async speak(text: string, lang: string, upcoming: string[], token: number): Promise<void> {
    const synth = this.synth;
    if (!synth) return;
    // Local speech knows Cantonese as zh-HK; the target code `yue` would match nothing.
    const speechLang = lang === 'yue' ? 'zh-HK' : lang;
    if (this.remoteOk && wantsRemoteVoice(synth.getVoices(), speechLang)) {
      const mine = this.fetchAudio(text, lang);
      for (const next of upcoming) void this.fetchAudio(next, lang);
      const bytes = await mine;
      this.fetching.delete(`${lang}\n${text}`);
      if (token !== this.token) return;
      this.note(`server voice: ${bytes ? `${bytes.byteLength} bytes` : `none (${this.options.remoteError?.() || 'no reason given'})`}`);
      if (bytes && (await this.play(bytes))) return;
      // Signed out, over quota, offline or the page blocks audio: the browser's own voice takes over for the rest.
      this.remoteOk = false;
      this.fetching.clear();
    }
    await this.speakLocalThroughBackground(text, speechLang, token);
  }

  /**
   * The browser cancels system speech the moment the page goes to the background (the screen turning off), and
   * cannot start any while it stays there. Marching on would only fail, sentence after sentence, and lose the text.
   * So it waits for the page to come back and says the sentence that was cut off again.
   */
  private async speakLocalThroughBackground(text: string, lang: string, token: number): Promise<void> {
    for (let attempt = 0; attempt < MAX_RESUMES; attempt++) {
      const error = await this.speakLocal(text, lang);
      if (!error || token !== this.token) return;
      // A failure with the page in front is a real one: move on rather than loop on it.
      if (this.doc.visibilityState !== 'hidden') return;
      this.note('paused: system speech is cut off while the page is in the background; will say it again when it is back');
      await this.whenVisible();
      if (token !== this.token) return;
      this.note('page is back: saying the sentence again');
    }
  }

  private whenVisible(): Promise<void> {
    if (this.doc.visibilityState !== 'hidden') return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        if (this.doc.visibilityState === 'hidden') return;
        this.doc.removeEventListener('visibilitychange', done);
        this.wake = null;
        resolve();
      };
      this.doc.addEventListener('visibilitychange', done);
      // stop() must not leave this waiting forever.
      this.wake = () => {
        this.doc.removeEventListener('visibilitychange', done);
        this.wake = null;
        resolve();
      };
    });
  }

  /** Resolves with null when the speech ran to its end, or with the system's error name. */
  private speakLocal(text: string, lang: string): Promise<string | null> {
    const synth = this.synth;
    if (!synth) return Promise.resolve(null);
    return new Promise((resolve) => {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = lang;
      const voice = pickVoice(synth.getVoices(), lang);
      if (voice) utterance.voice = voice;
      utterance.onstart = () => this.note('utterance start');
      utterance.onend = () => {
        this.note('utterance end');
        resolve(null);
      };
      utterance.onerror = (event) => {
        const error = (event as SpeechSynthesisErrorEvent).error ?? 'error';
        this.note(`utterance error: ${error}`);
        resolve(error);
      };
      this.current = utterance;
      synth.speak(utterance);
    });
  }

  /**
   * Plays MP3 through the Web Audio API rather than an <audio> element, which a page's media-src
   * policy could refuse. False when it cannot play, so the caller falls back to the local voice.
   */
  private async play(bytes: ArrayBuffer): Promise<boolean> {
    const viaElement = await this.playElement(bytes);
    this.note(`play via audio element: ${viaElement}`);
    if (viaElement) return true;
    const viaWebAudio = await this.playWebAudio(bytes);
    this.note(`play via web audio: ${viaWebAudio}`);
    return viaWebAudio;
  }

  /** The preferred way: a media element, which the browser keeps playing with the screen off. */
  private async playElement(bytes: ArrayBuffer): Promise<boolean> {
    let url = '';
    try {
      url = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }));
      const element = (this.voice ??= new Audio());
      const finished = new Promise<boolean>((resolve) => {
        element.onended = () => resolve(true);
        // Paused from outside (stop): hand control back so the reading loop can see it was stopped.
        element.onpause = () => resolve(true);
        element.onerror = () => resolve(false);
      });
      element.src = url;
      // A browser always returns a promise here; anything else means media elements are not really supported.
      const started = element.play() as Promise<void> | undefined;
      if (typeof started?.then !== 'function') return false;
      await started;
      return await finished;
    } catch {
      return false;
    } finally {
      if (url) URL.revokeObjectURL(url);
    }
  }

  /**
   * Plays MP3 through the Web Audio API rather than an <audio> element, which a page's media-src
   * policy could refuse. False when it cannot play, so the caller falls back to the local voice.
   */
  private async playWebAudio(bytes: ArrayBuffer): Promise<boolean> {
    try {
      const context = (this.audio ??= new AudioContext());
      if (context.state === 'suspended') await Promise.race([context.resume(), sleep(RESUME_WAIT_MS)]);
      if (context.state !== 'running') return false;
      const buffer = await context.decodeAudioData(bytes.slice(0));
      await new Promise<void>((resolve) => {
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(context.destination);
        source.onended = () => resolve();
        this.source = source;
        source.start();
      });
      return true;
    } catch {
      return false;
    }
  }
}
