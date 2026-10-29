import { MAX_BATCH_CHARS, MAX_BATCH_SEGMENTS, MAX_SEGMENT_CHARS } from '../shared/messages';
import type { Settings } from '../shared/settings';
import type { Translate } from './controller';
import { timedFeed, type TimedFeed } from './timed-feed';
import { parseTimedText, type Cue } from './timedtext';

/**
 * Video subtitles (FR-19).
 *
 * Two kinds of player, one pipeline. Some expose real text tracks, so the browser parses the VTT
 * and hands us every cue up front; others paint their captions into the page as ordinary elements
 * and tell us nothing. Both are read through the same small feed below, so the translating,
 * caching and drawing happen once.
 *
 * Nothing is fetched here: a track is switched to `hidden`, which makes the browser load its cues
 * without drawing them, and we draw both languages ourselves. That keeps us clear of the players'
 * own caption styling and of cross-origin subtitle files.
 */

export const SUBTITLE_ATTR_VALUE = 'subtitle';
const STYLE_ID = 'yilin-subtitle-style';
const COLOUR_STYLE_ID = 'yilin-subtitle-colour';

/** A source of subtitle lines, whether the player keeps them as cues or as elements. */
export interface CueFeed {
  /** Every line the source knows about, for translating ahead of time. Empty when it only reveals the current one. */
  all(): string[];
  /** The lines showing right now. */
  active(): string[];
  /** Calls back whenever the showing lines change; returns a function that stops listening. */
  onChange(listener: () => void): () => void;
  /** Stops using the source and puts the player back the way it was. */
  release(): void;
  /**
   * True when the source rewrites the current line as it goes — automatic captions grow word by
   * word. Those have to be left to settle before they are worth translating.
   */
  live?: boolean;
  /** The player's own caption element, when there is one: players rebuild it, and the new one has to be hidden too. */
  host?: Element;
}

const clean = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Players that draw their own captions. The value is the element holding the current line. */
export const CAPTION_SELECTORS = [
  '.ytp-caption-window-container', // YouTube
  '.caption-window', // YouTube, older markup and embeds
  '.vjs-text-track-display', // video.js: many news sites
  '.jw-captions', // JW Player
  '.shaka-text-container', // Shaka
  '.plyr__captions', // Plyr
  '[class*="captionsContainer" i]',
  '[class*="subtitleContainer" i]',
  '[class*="captionWindow" i]',
  '[class*="textTrackDisplay" i]',
];

/** Reads a real text track. The cues are already parsed by the browser, so the whole file is known. */
export function trackFeed(track: TextTrack): CueFeed {
  const previousMode = track.mode;
  // `hidden` loads the cues without the browser drawing them; `disabled` would leave cues empty.
  track.mode = 'hidden';
  const cueTexts = (list: TextTrackCueList | ArrayLike<TextTrackCue> | null) => {
    const out: string[] = [];
    for (let i = 0; i < (list?.length ?? 0); i++) {
      const cue = list![i] as TextTrackCue & { text?: string };
      const text = clean(cue?.text ?? '');
      if (text) out.push(text);
    }
    return out;
  };
  return {
    all: () => cueTexts(track.cues),
    active: () => cueTexts(track.activeCues),
    onChange(listener) {
      track.addEventListener('cuechange', listener);
      return () => track.removeEventListener('cuechange', listener);
    },
    release() {
      track.mode = previousMode;
    },
  };
}

/**
 * Reads captions a player draws itself. Only the current line is ever available, so each line is
 * translated as it appears — which is why the cache matters more here than for tracks.
 */
export const CAPTIONS_OFF_ATTR = 'data-yilin-captions-off';
/** On the root element, never on the one the rule `[CAPTIONS_OFF_ATTR] { visibility: hidden }` applies to: that hides the whole page. */
const PAGE_HIDES_CAPTIONS_ATTR = 'data-yilin-hide-captions';

export function domFeed(host: Element): CueFeed {
  const view = host.ownerDocument.defaultView;
  let observer: MutationObserver | undefined;
  // We draw the original ourselves, right above the translation and movable with it. Leaving the
  // player's own caption visible would show the same sentence twice, in two places.
  host.setAttribute(CAPTIONS_OFF_ATTR, '');
  const read = () => {
    // Players put each caption line in its own element; plain textContent glues the last word of
    // one line to the first of the next ("differentcapabilities").
    const parts: string[] = [];
    const walker = host.ownerDocument.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) parts.push(walker.currentNode.textContent ?? '');
    const text = clean(parts.join(' '));
    return text ? [text] : [];
  };
  return {
    host,
    live: true,
    all: () => [],
    active: read,
    onChange(listener) {
      observer = new (view?.MutationObserver ?? MutationObserver)(() => listener());
      observer.observe(host, { childList: true, subtree: true, characterData: true });
      return () => observer?.disconnect();
    },
    release() {
      observer?.disconnect();
      host.removeAttribute(CAPTIONS_OFF_ATTR);
    },
  };
}

interface Attachment {
  feed: CueFeed;
  stop: () => void;
  overlay: HTMLElement;
  /** The player's whole caption file with its times, once it has been seen; it takes over from `feed`. */
  timed?: TimedFeed;
  stopTimed?: () => void;
  /** Live captions only: the last text that stopped changing, and the pair (original, translation) on screen for it. */
  settleTimer?: ReturnType<typeof setTimeout>;
  settled?: string;
  /** When the current wait for quiet began, so a caption that never goes quiet is still translated. */
  waitingSince?: number;
  shownSource?: string;
  shown?: string;
}

export interface SubtitleOptions {
  translate: Translate;
  settings: Settings;
  /** Overridden in tests; the default reads the page's own players. */
  feeds?: (doc: Document, skip?: ReadonlyMap<HTMLVideoElement, unknown>) => { video: HTMLVideoElement; feed: CueFeed }[];
  /** How long a live caption must hold still before it is worth translating. */
  settleMs?: number;
  /** Where the viewer dragged the subtitles last time, as an offset from the default spot. */
  offset?: { x: number; y: number };
  onOffsetChange?: (offset: { x: number; y: number }) => void;
  /** Puts the caption hook into the page's own JavaScript world, where the player's downloads are visible. */
  injectHook?: () => void;
  /** How often the playhead is compared with the caption times. */
  pollMs?: number;
  /** Called after subtitle translation starts or stops, for a switch that shows which it is. */
  onActiveChange?: () => void;
}

/** The video a page is showing, from its address (YouTube watch, embed and shorts pages). */
function pageVideoId(doc: Document): string {
  try {
    const url = new URL(doc.location.href);
    return url.searchParams.get('v') ?? url.pathname.match(/^\/(?:embed|shorts|live)\/([\w-]{6,})/)?.[1] ?? '';
  } catch {
    return '';
  }
}

/**
 * YouTube keeps no event for the CC switch; its button says whether captions are on. An advertisement
 * plays in the same <video>, on its own clock, so the film's captions must not be drawn over it.
 */
function captionsEnabled(doc: Document): boolean {
  if (doc.querySelector('.html5-video-player.ad-showing, .html5-video-player.ad-interrupting')) return false;
  // The desktop player's button, or the one in the phone site's own bar.
  const button = doc.querySelector('.ytp-subtitles-button, .ytmClosedCaptioningButtonButton');
  return !button || button.getAttribute('aria-pressed') !== 'false';
}

/** How long after the hook goes in to wait for a caption file before asking the player for it again. */
const NUDGE_AFTER_MS = 1000;

/** How long an automatic caption must stop growing before it is worth translating. */
const SETTLE_MS = 300;

/**
 * Continuous speech barely pauses, so waiting for quiet alone would leave the subtitles seconds
 * behind the picture: whatever is showing is translated at least this often.
 */
const MAX_WAIT_MS = 800;

/** Smaller than this is a thumbnail preview or a hover autoplay, not something anyone is reading. */
const MIN_VIDEO_WIDTH = 240;

export class SubtitleTranslator {
  private settings: Settings;
  private attached = new Map<HTMLVideoElement, Attachment>();
  /** Videos whose player has shown caption text, which an empty caption element never does. */
  private showedCaptions = new WeakSet<HTMLVideoElement>();
  private translations = new Map<string, string>();
  private pending = new Set<string>();
  /** Lines we have already asked about, including ones that came back as failures. */
  private attempted = new Set<string>();
  private active = false;
  private scan: MutationObserver | undefined;
  /** The caption file the player last downloaded, parsed; undefined until one is seen. */
  private captions: { videoId: string; cues: Cue[] } | undefined;
  private nudgeTimer: ReturnType<typeof setTimeout> | undefined;
  private offset: { x: number; y: number };
  private drag: { pointerId: number; startX: number; startY: number; fromX: number; fromY: number } | undefined;

  constructor(private doc: Document, private options: SubtitleOptions) {
    this.settings = options.settings;
    this.offset = { ...(options.offset ?? { x: 0, y: 0 }) };
  }

  /** Moves the subtitles back under the picture after a drag put them somewhere unhelpful. */
  resetPosition(): void {
    this.offset = { x: 0, y: 0 };
    this.options.onOffsetChange?.(this.offset);
    for (const video of this.attached.keys()) this.draw(video);
  }

  updateSettings(settings: Settings): void {
    const languageChanged = settings.targetLang !== this.settings.targetLang;
    this.settings = settings;
    if (languageChanged) {
      // Lines already translated are in the old language; they have to go, and the ones that
      // failed deserve another chance in the new language.
      this.translations.clear();
      this.attempted.clear();
      for (const video of this.attached.keys()) void this.prefetch(video);
    }
    this.applyColours();
    for (const video of this.attached.keys()) this.draw(video);
  }

  private follow = () => {
    for (const video of this.attached.keys()) {
      const attachment = this.attached.get(video);
      if (attachment?.overlay.parentElement) this.place(video, attachment.overlay);
    }
  };

  /**
   * Whether this video has subtitles we can read: a text track, or a known player's caption element
   * that has shown text. An empty caption element proves nothing — a player keeps one whether or not
   * the video has any captions (a news site's video had the element, no captions at all, and a badge
   * that could translate nothing).
   */
  hasSource(video: HTMLVideoElement): boolean {
    const tracks = video.textTracks;
    for (let i = 0; i < (tracks?.length ?? 0); i++) {
      const kind = tracks[i]?.kind;
      if (kind === 'subtitles' || kind === 'captions') return true;
    }
    if (this.showedCaptions.has(video)) return true;
    const host = CAPTION_SELECTORS.map((selector) => captionHost(video, selector)).find(Boolean);
    if (host && (host.textContent ?? '').trim() !== '') this.showedCaptions.add(video);
    return this.showedCaptions.has(video);
  }

  /** Whether subtitle translation is running. */
  get running(): boolean {
    return this.active;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.ensureStyle();
    this.look();
    // The overlay is placed against the video's box, so anything that moves the box moves it too.
    const view = this.doc.defaultView;
    view?.addEventListener('scroll', this.follow, { passive: true, capture: true });
    view?.addEventListener('resize', this.follow, { passive: true });
    this.doc.addEventListener('fullscreenchange', this.follow);
    // Players are mounted late and swapped between clips, so one look at start is not enough.
    this.scan = new MutationObserver(() => this.look());
    this.scan.observe(this.doc.documentElement, { childList: true, subtree: true });
    // The player's own caption file has every line with its time, which beats reading each line
    // off the screen after it appeared. It is only downloaded when the viewer turns captions on,
    // so if they already were, switching them off and on makes the player fetch it again.
    view?.addEventListener('message', this.onCaptionMessage);
    if (this.options.injectHook) {
      this.options.injectHook();
      this.nudgeTimer = setTimeout(() => this.nudge(), NUDGE_AFTER_MS);
    }
    this.options.onActiveChange?.();
  }

  private nudge(): void {
    if (!this.active || this.captions) return;
    const button = this.doc.querySelector<HTMLElement>('.ytp-subtitles-button, .ytmClosedCaptioningButtonButton');
    if (button?.getAttribute('aria-pressed') !== 'true') return;
    button.click();
    setTimeout(() => button.click(), 80);
  }

  /** The hook's report of a caption file the player just downloaded. */
  private onCaptionMessage = (event: MessageEvent): void => {
    const data = event.data as { source?: unknown; kind?: unknown; videoId?: unknown; body?: unknown } | null;
    if (event.source !== this.doc.defaultView || data?.source !== 'yilin-captions' || typeof data.body !== 'string') return;
    const here = pageVideoId(this.doc);
    const videoId = typeof data.videoId === 'string' && data.videoId ? data.videoId : here;
    // A late answer for the video the viewer has already left.
    if (here && videoId && here !== videoId) return;
    const cues = parseTimedText(data.body, typeof data.kind === 'string' ? data.kind : '');
    if (cues.length === 0) return;
    this.captions = { videoId, cues };
    this.followCaptions();
  };

  /** The page's main player: the largest one, since thumbnails and previews are never the ones read. */
  private mainVideo(): HTMLVideoElement | undefined {
    let best: HTMLVideoElement | undefined;
    let bestWidth = -1;
    for (const video of this.attached.keys()) {
      const width = video.getBoundingClientRect?.().width ?? 0;
      if (width > bestWidth) [best, bestWidth] = [video, width];
    }
    return best;
  }

  private followCaptions(): void {
    const video = this.mainVideo();
    const attachment = video && this.attached.get(video);
    if (!video || !attachment || !this.captions) return;
    attachment.stopTimed?.();
    const timed = timedFeed(video, this.captions.cues, {
      videoId: this.captions.videoId,
      enabled: () => captionsEnabled(this.doc),
      pollMs: this.options.pollMs,
    });
    attachment.timed = timed;
    attachment.stopTimed = timed.onChange(() => this.draw(video));
    void this.prefetch(video);
    this.draw(video);
  }

  /** The caption file while it is for the video on the page; otherwise whatever the player draws. */
  private feedOf(attachment: Attachment): CueFeed {
    const { timed } = attachment;
    const here = pageVideoId(this.doc);
    return timed && (!here || !timed.videoId || timed.videoId === here) ? timed : attachment.feed;
  }

  stop(): void {
    this.active = false;
    clearTimeout(this.nudgeTimer);
    this.captions = undefined;
    this.doc.defaultView?.removeEventListener('message', this.onCaptionMessage);
    this.scan?.disconnect();
    this.scan = undefined;
    const view = this.doc.defaultView;
    view?.removeEventListener('scroll', this.follow, { capture: true });
    view?.removeEventListener('resize', this.follow);
    this.doc.removeEventListener('fullscreenchange', this.follow);
    for (const [video, attachment] of this.attached) {
      clearTimeout(attachment.settleTimer);
      video.removeEventListener('timeupdate', this.follow);
      attachment.stopTimed?.();
      attachment.stop();
      attachment.feed.release();
      attachment.overlay.remove();
      this.attached.delete(video);
    }
    this.doc.documentElement.removeAttribute(PAGE_HIDES_CAPTIONS_ATTR);
    this.doc.getElementById(STYLE_ID)?.remove();
    this.doc.getElementById(COLOUR_STYLE_ID)?.remove();
    this.options.onActiveChange?.();
  }

  /** What was found on the page and how far it got; development builds report it. */
  inspect(): {
    active: boolean;
    videos: number;
    lines: number;
    players: { width: number; source: 'track' | 'captions' | 'none'; attached: boolean }[];
  } {
    const players = [...this.doc.querySelectorAll('video')].map((video) => {
      const tracks = video.textTracks;
      let hasTrack = false;
      for (let i = 0; i < (tracks?.length ?? 0); i++) {
        const kind = tracks[i]?.kind;
        if (kind === 'subtitles' || kind === 'captions') hasTrack = true;
      }
      const host = CAPTION_SELECTORS.map((selector) => captionHost(video, selector)).find(Boolean);
      return {
        width: Math.round(video.getBoundingClientRect?.().width ?? 0),
        source: hasTrack ? ('track' as const) : host ? ('captions' as const) : ('none' as const),
        attached: this.attached.has(video),
      };
    });
    return { active: this.active, videos: this.attached.size, lines: this.translations.size, players };
  }

  private look(): void {
    if (!this.active) return;
    // Building a feed changes the player (hides its captions, switches a track to hidden), so the
    // ones already held are skipped before that happens, not after.
    for (const { video, feed } of (this.options.feeds ?? findFeeds)(this.doc, this.attached)) {
      if (this.attached.has(video)) continue;
      const overlay = this.doc.createElement('div');
      overlay.setAttribute('data-yilin', SUBTITLE_ATTR_VALUE);
      overlay.className = 'yilin-subtitle';
      this.makeDraggable(video, overlay);
      const stop = feed.onChange(() => this.draw(video));
      // Playing moves the player on some sites (sticky miniplayers), and it is a cheap tick.
      video.addEventListener('timeupdate', this.follow);
      this.attached.set(video, { feed, stop, overlay });
      this.doc.documentElement.setAttribute(PAGE_HIDES_CAPTIONS_ATTR, '');
      void this.prefetch(video);
      this.draw(video);
    }
    this.rehost();
    // A caption file seen before this player was found (or before it was swapped) still applies.
    if (this.captions) {
      const main = this.mainVideo();
      if (main && !this.attached.get(main)?.timed) this.followCaptions();
    }
  }

  /**
   * Players rebuild their caption element (YouTube does after every advertisement). The one we hid is
   * then gone and the new one shows the player's own caption again, a second copy of the original
   * above ours; so a feed whose element left the page is replaced by one for the new element.
   */
  private rehost(): void {
    for (const [video, attachment] of this.attached) {
      const host = attachment.feed.host;
      if (!host || host.isConnected) continue;
      const others = new Map(this.attached);
      others.delete(video);
      const fresh = (this.options.feeds ?? findFeeds)(this.doc, others).find((found) => found.video === video);
      attachment.stop();
      attachment.feed.release();
      if (!fresh) {
        attachment.stopTimed?.();
        attachment.overlay.remove();
        this.attached.delete(video);
        video.removeEventListener('timeupdate', this.follow);
        continue;
      }
      attachment.feed = fresh.feed;
      attachment.stop = fresh.feed.onChange(() => this.draw(video));
      this.draw(video);
    }
  }

  /** Translates the whole file at once where the player gives us one, so playback never waits. */
  private async prefetch(video: HTMLVideoElement): Promise<void> {
    const attachment = this.attached.get(video);
    const lines = attachment ? this.feedOf(attachment).all() : [];
    if (lines.length > 0) await this.request(lines);
    this.draw(video);
  }

  private async request(lines: string[]): Promise<void> {
    const wanted = [...new Set(lines)].filter((line) => !this.attempted.has(line) && !this.pending.has(line));
    if (wanted.length === 0) return;
    for (const line of wanted) this.pending.add(line);
    let done = 0;
    try {
      while (done < wanted.length) {
        // The service takes a few short segments at a time; a whole caption file goes in pieces.
        const batch: string[] = [];
        let chars = 0;
        while (done + batch.length < wanted.length && batch.length < MAX_BATCH_SEGMENTS) {
          const next = wanted[done + batch.length]!.slice(0, MAX_SEGMENT_CHARS);
          if (batch.length > 0 && chars + next.length > MAX_BATCH_CHARS) break;
          batch.push(next);
          chars += next.length;
        }
        const results = await this.options.translate(
          batch.map((text, n) => ({ id: `sub-${n}`, text })),
          this.settings.targetLang,
        );
        results.forEach((result, n) => {
          const source = wanted[done + n];
          if (source && result.ok && result.text) this.translations.set(source, result.text);
        });
        done += batch.length;
        // Lines near the playhead come first, so they are on screen before the rest has been asked for.
        for (const video of this.attached.keys()) this.draw(video);
      }
    } finally {
      for (const [i, line] of wanted.entries()) {
        this.pending.delete(line);
        // Marked even when the service failed: a line that cannot be translated keeps its original
        // on screen, and asking again on every redraw would spin for as long as the clip plays.
        // Lines never reached (the request threw) stay open for a later try.
        if (i < done) this.attempted.add(line);
      }
    }
  }

  private draw(video: HTMLVideoElement): void {
    const attachment = this.attached.get(video);
    if (!attachment) return;
    const feed = this.feedOf(attachment);
    const lines = feed.active();
    const { overlay } = attachment;
    if (lines.length === 0) {
      // The captions went away: the pair on screen belongs to a sentence that is over.
      clearTimeout(attachment.settleTimer);
      attachment.settled = attachment.shownSource = attachment.shown = undefined;
      overlay.remove();
      return;
    }
    overlay.replaceChildren();
    if (feed.live) {
      // Automatic captions are rewritten on every word, so a sentence is translated once it stops
      // moving. The original is held back until its translation is ready and the two appear
      // together, then stay put until the next sentence is ready — otherwise the original races
      // ahead of the translation and the translation flashes once per word.
      if (attachment.shownSource !== undefined) {
        if (this.settings.displayMode !== 'translation') overlay.append(this.row(attachment.shownSource, 'source'));
        if (attachment.shown) overlay.append(this.row(attachment.shown, 'translation'));
      }
      this.settle(video);
      if (!overlay.hasChildNodes()) {
        overlay.remove();
        return;
      }
    } else {
      // A file we already translated: every line has its own translation under it.
      const missing = lines.filter((line) => !this.attempted.has(line) && !this.pending.has(line));
      if (missing.length > 0) void this.request(missing).then(() => this.draw(video));
      for (const line of lines) {
        const translated = this.translations.get(line);
        if (this.settings.displayMode !== 'translation') overlay.append(this.row(line, 'source'));
        if (translated) overlay.append(this.row(translated, 'translation'));
      }
    }
    this.place(video, overlay);
  }

  /** Waits for a live caption to hold still, then translates that sentence once. */
  private settle(video: HTMLVideoElement): void {
    const attachment = this.attached.get(video);
    if (!attachment) return;
    clearTimeout(attachment.settleTimer);
    const now = Date.now();
    attachment.waitingSince ??= now;
    const wait = Math.max(0, Math.min(this.options.settleMs ?? SETTLE_MS, attachment.waitingSince + MAX_WAIT_MS - now));
    attachment.settleTimer = setTimeout(() => {
      const current = this.attached.get(video);
      if (!current) return;
      current.waitingSince = undefined;
      const text = current.feed.active().join(' ');
      if (!text || text === current.settled) return;
      current.settled = text;
      void this.request([text]).then(() => {
        const after = this.attached.get(video);
        // A later sentence may have settled while this one was in flight; the newest one wins.
        if (!after || after.settled !== text) return;
        after.shownSource = text;
        after.shown = this.translations.get(text);
        this.draw(video);
      });
    }, wait);
  }

  /**
   * One row per line, always stacked: the original above its translation. An earlier version let
   * the boxes flow inline, so two short lines ended up side by side and the pair read as one
   * sentence.
   */
  private row(text: string, kind: 'source' | 'translation'): HTMLElement {
    const p = this.doc.createElement('p');
    p.className = `yilin-subtitle-line yilin-subtitle-${kind}`;
    // Translation output is untrusted: only ever written as text.
    p.textContent = text;
    return p;
  }

  /**
   * The whole block moves as one, so the original stays with its translation. Players put their
   * own captions, logos and controls in different places, and no fixed spot suits every site.
   */
  private makeDraggable(video: HTMLVideoElement, overlay: HTMLElement): void {
    overlay.addEventListener('pointerdown', (event) => {
      const pointer = event as PointerEvent;
      // Taking the press keeps it away from the player, which would treat it as play/pause.
      pointer.preventDefault();
      pointer.stopPropagation();
      this.drag = { pointerId: pointer.pointerId, startX: pointer.clientX, startY: pointer.clientY, fromX: this.offset.x, fromY: this.offset.y };
      overlay.setPointerCapture?.(pointer.pointerId);
    });
    overlay.addEventListener('pointermove', (event) => {
      const pointer = event as PointerEvent;
      if (this.drag?.pointerId !== pointer.pointerId) return;
      this.offset = { x: this.drag.fromX + (pointer.clientX - this.drag.startX), y: this.drag.fromY + (pointer.clientY - this.drag.startY) };
      this.draw(video);
    });
    const end = (event: Event) => {
      const pointer = event as PointerEvent;
      if (this.drag?.pointerId !== pointer.pointerId) return;
      this.drag = undefined;
      overlay.releasePointerCapture?.(pointer.pointerId);
      this.options.onOffsetChange?.(this.offset);
    };
    overlay.addEventListener('pointerup', end);
    overlay.addEventListener('pointercancel', end);
  }

  /**
   * The overlay is positioned against the video's own box rather than put inside the player, so no
   * player's layout has to cooperate. In fullscreen only the fullscreen element's subtree is drawn,
   * so the overlay moves in there.
   */
  private place(video: HTMLVideoElement, overlay: HTMLElement): void {
    const host = this.doc.fullscreenElement ?? this.doc.body;
    if (overlay.parentElement !== host) host.append(overlay);
    const rect = video.getBoundingClientRect?.();
    // A feed thumbnail autoplaying under the pointer is this small. Drawing there once produced a
    // column one word wide across the page, with the real player's captions untouched.
    if (!rect || rect.width < MIN_VIDEO_WIDTH) {
      overlay.remove();
      return;
    }
    const fixed = host === this.doc.body;
    const hostRect = fixed ? null : (host as Element).getBoundingClientRect?.();
    overlay.style.position = fixed ? 'fixed' : 'absolute';
    overlay.style.left = `${rect.left - (hostRect?.left ?? 0) + this.offset.x}px`;
    overlay.style.width = `${rect.width}px`;
    // Sits just above the player's own control bar, until the viewer drags it elsewhere.
    overlay.style.top = `${rect.top - (hostRect?.top ?? 0) + rect.height * 0.74 + this.offset.y}px`;
  }

  private ensureStyle(): void {
    if (!this.doc.getElementById(STYLE_ID)) {
      const style = this.doc.createElement('style');
      style.id = STYLE_ID;
      style.textContent = `
.yilin-subtitle {
  position: fixed;
  z-index: 2147483000;
  margin: 0;
  padding: 0 2%;
  box-sizing: border-box;
  text-align: center;
  /* The box itself takes the press, so dragging it never reaches the player underneath. */
  cursor: move;
  touch-action: none;
  user-select: none;
}
.yilin-subtitle-line {
  display: block;
  width: fit-content;
  max-width: 100%;
  margin: 3px auto 0;
  padding: 2px 10px;
  border-radius: 4px;
  font-family: system-ui, sans-serif;
  font-size: clamp(14px, 2.2vw, 26px);
  line-height: 1.35;
  text-align: center;
}
.yilin-subtitle-source {
  color: #fff;
  font-size: clamp(12px, 1.8vw, 21px);
}
/* Players we draw for ourselves keep their own captions hidden, or the original shows twice. */
[${CAPTIONS_OFF_ATTR}] { visibility: hidden !important; }
/* By selector as well: some players build a new caption element for every line, and a rule on the one we
   marked would let each new one show for a moment, the original appearing word by word. */
:root[${PAGE_HIDES_CAPTIONS_ATTR}] :is(${CAPTION_SELECTORS.join(', ')}) { visibility: hidden !important; }
`;
      (this.doc.head ?? this.doc.documentElement).append(style);
    }
    this.applyColours();
  }

  /** The translation's own colours (doc/03 FR-19), kept in a second sheet so they can change alone. */
  private applyColours(): void {
    if (!this.doc.getElementById(STYLE_ID)) return;
    let sheet = this.doc.getElementById(COLOUR_STYLE_ID);
    if (!sheet) {
      sheet = this.doc.createElement('style');
      sheet.id = COLOUR_STYLE_ID;
      (this.doc.head ?? this.doc.documentElement).append(sheet);
    }
    // The original sits on the same background as its translation, so the pair reads as one block.
    sheet.textContent = `
.yilin-subtitle-source,
.yilin-subtitle-translation {
  background: ${this.settings.subtitleBackground} !important;
}
.yilin-subtitle-translation {
  color: ${this.settings.subtitleColor} !important;
}
`;
  }
}

/** Finds the players on the page: real text tracks first, then the ones that draw captions themselves. */
function findFeeds(doc: Document, skip?: ReadonlyMap<HTMLVideoElement, unknown>): { video: HTMLVideoElement; feed: CueFeed }[] {
  const found: { video: HTMLVideoElement; feed: CueFeed }[] = [];
  for (const video of doc.querySelectorAll('video')) {
    if (skip?.has(video)) continue;
    // Reading a thumbnail preview would hide a real player's captions somewhere off screen.
    if ((video.getBoundingClientRect?.().width ?? 0) < MIN_VIDEO_WIDTH) continue;
    const tracks = video.textTracks;
    let chosen: TextTrack | undefined;
    for (let i = 0; i < (tracks?.length ?? 0); i++) {
      const track = tracks[i]!;
      if (track.kind !== 'subtitles' && track.kind !== 'captions') continue;
      // A track the player is already showing is the one the viewer picked.
      if (!chosen || track.mode === 'showing') chosen = track;
    }
    const host = CAPTION_SELECTORS.map((selector) => captionHost(video, selector)).find(Boolean);
    if (chosen) {
      // A player with its own caption renderer (video.js and friends) draws the cues itself even
      // though the track is hidden, so its container is hidden along with the track.
      found.push({ video, feed: host ? hidingCaptions(trackFeed(chosen), host) : trackFeed(chosen) });
      continue;
    }
    if (host) found.push({ video, feed: domFeed(host) });
  }
  return found;
}

/** Keeps a player's own caption container out of sight for as long as we are drawing. */
function hidingCaptions(feed: CueFeed, host: Element): CueFeed {
  host.setAttribute(CAPTIONS_OFF_ATTR, '');
  return {
    ...feed,
    host,
    release() {
      host.removeAttribute(CAPTIONS_OFF_ATTR);
      feed.release();
    },
  };
}

/** The caption element belonging to this player, not to another one further up the page. */
function captionHost(video: HTMLVideoElement, selector: string): Element | null {
  for (let node: Element | null = video.parentElement; node; node = node.parentElement) {
    const match = node.querySelector(selector);
    if (match) return match;
  }
  return null;
}
