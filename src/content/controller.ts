import {
  MAX_BATCH_CHARS,
  MAX_BATCH_SEGMENTS,
  MAX_SEGMENT_CHARS,
  type ErrorCode,
  type PageState,
  type SegmentInput,
  type SegmentResult,
} from '../shared/messages';
import { createTranslator, resolveUiLang, type MessageKey } from '../shared/i18n';
import type { Settings } from '../shared/settings';
import { protectTerms, restoreTerms, termsSurvive } from './protect';
import { findRepeatedTerms, glossaryFor, lockTerms } from './terms';
import { LINE_ATTR, SEGMENT_ATTR, YILIN_ATTR, extractSegments, fingerprint, normalizeText, segmentMath, segmentText } from './extractor';
import { RETRY_ATTR, applyStyle, hasTranslation, removeAllTranslations, removeTranslation, renderTranslation } from './renderer';

export type Translate = (segments: SegmentInput[], targetLang: Settings['targetLang']) => Promise<SegmentResult[]>;

export interface Visibility {
  observe(el: Element): void;
  unobserve(el: Element): void;
  disconnect(): void;
}

export type VisibilityFactory = (onVisible: (el: Element) => void) => Visibility;

type SegmentStatus = 'new' | 'queued' | 'inflight' | 'done' | 'failed';

interface Segment {
  id: string;
  el: Element;
  text: string;
  fp: string;
  status: SegmentStatus;
  compact: boolean;
  /** Kept so the translation can be restored when the page re-renders the paragraph. */
  translation?: string;
  /** The translation is the original again: nothing is shown. */
  same?: boolean;
  error?: ErrorCode;
}

export interface ControllerOptions {
  translate: Translate;
  settings: Settings;
  onState?: (state: PageState) => void;
  visibility?: VisibilityFactory;
  maxConcurrent?: number;
  flushDelayMs?: number;
  rescanDelayMs?: number;
  sweepDelayMs?: number;
  /** Waits before retrying after the service refuses a whole batch. */
  backoffMs?: readonly number[];
}


/** How far beyond the viewport a paragraph is translated ahead of the reader (doc/12 §7.1). */
export const VIEWPORT_MARGIN_PX = 1500;

/** Translate content near the viewport first; jsdom and very old engines translate everything. */
export const defaultVisibility: VisibilityFactory = (onVisible) => {
  if (typeof IntersectionObserver === 'undefined') {
    return { observe: (el) => queueMicrotask(() => onVisible(el)), unobserve() {}, disconnect() {} };
  }
  const io = new IntersectionObserver(
    (entries) => entries.forEach((e) => e.isIntersecting && onVisible(e.target)),
    { rootMargin: `${VIEWPORT_MARGIN_PX}px 0px` },
  );
  return { observe: (el) => io.observe(el), unobserve: (el) => io.unobserve(el), disconnect: () => io.disconnect() };
};

export class TranslationController {
  private segments = new Map<Element, Segment>();
  private byId = new Map<string, Segment>();
  private queue: Segment[] = [];
  private nextId = 1;
  /** Bumped on stop/restore so that late responses from an older run are dropped. */
  private generation = 0;
  private locks: Promise<Map<string, string>> | undefined;
  private active = false;
  private stopped = false;
  private inflight = 0;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private rescanTimer: ReturnType<typeof setTimeout> | undefined;
  private sweepTimer: ReturnType<typeof setTimeout> | undefined;
  /** Consecutive batches the service refused wholesale; reset by any batch that comes back translated. */
  private rateLimitStrikes = 0;
  /** Set once backing off stopped helping: the page waits for the reader to pick another service. */
  private blocked: PageState['blocked'];
  private visibility: Visibility | undefined;
  private mutations: MutationObserver | undefined;
  private settings: Settings;
  private readonly maxConcurrent: number;
  private readonly flushDelayMs: number;
  private readonly rescanDelayMs: number;
  private readonly sweepDelayMs: number;
  private readonly backoffMs: readonly number[];

  constructor(
    private readonly doc: Document,
    private readonly options: ControllerOptions,
  ) {
    this.settings = options.settings;
    this.maxConcurrent = options.maxConcurrent ?? 3;
    this.flushDelayMs = options.flushDelayMs ?? 30;
    this.rescanDelayMs = options.rescanDelayMs ?? 300;
    this.backoffMs = options.backoffMs ?? [4000, 12000];
    this.sweepDelayMs = options.sweepDelayMs ?? 250;
  }

  getState(): PageState {
    let translated = 0, failed = 0, pending = 0, total = 0;
    for (const s of this.segments.values()) {
      if (!s.el.isConnected) continue;
      total++;
      if (s.status === 'done') translated++;
      else if (s.status === 'failed') failed++;
      else if (s.status === 'queued' || s.status === 'inflight') pending++;
    }
    const status = this.active ? (pending > 0 ? 'translating' : 'done') : this.stopped ? 'stopped' : 'idle';
    return { status, total, translated, failed, pending, ...(this.blocked ? { blocked: this.blocked } : {}) };
  }

  get isActive(): boolean {
    return this.active;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.stopped = false;
    this.rateLimitStrikes = 0;
    this.blocked = undefined;
    applyStyle(this.doc, this.settings);
    this.visibility = (this.options.visibility ?? defaultVisibility)((el) => this.onVisible(el));
    this.doc.addEventListener('click', this.onClick, true);
    this.doc.defaultView?.addEventListener('scroll', this.scheduleSweep, { passive: true });
    this.doc.defaultView?.addEventListener('resize', this.scheduleSweep, { passive: true });
    this.mutations = new MutationObserver((records) => this.onMutations(records));
    // attributes: a popover or accordion panel is often pre-rendered and only toggles a class or
    // style to show itself, with no childList/characterData change at all — without this, such
    // content is never (re)scanned once it appears (seen on a listing site's hover-preview card).
    this.mutations.observe(this.doc.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'],
    });
    this.scan();
    this.scheduleSweep();
    this.emit();
  }

  /** Stop sending new work; translations already shown stay on the page. */
  stop(): void {
    if (!this.active) return;
    this.halt();
    this.stopped = true;
    for (const s of this.segments.values()) {
      if (s.status === 'queued' || s.status === 'inflight') {
        removeTranslation(s.el);
        s.status = 'new';
      }
    }
    this.emit();
  }

  /** Remove everything the extension added and forget all state. */
  restore(): void {
    this.halt();
    this.stopped = false;
    this.locks = undefined;
    removeAllTranslations(this.doc);
    this.doc.querySelectorAll(`[${SEGMENT_ATTR}]`).forEach((el) => el.removeAttribute(SEGMENT_ATTR));
    this.segments.clear();
    this.byId.clear();
    this.emit();
  }

  retryFailed(): void {
    if (!this.active) return this.start();
    for (const s of this.segments.values()) if (s.status === 'failed') this.enqueue(s);
    this.emit();
  }

  updateSettings(settings: Settings): void {
    // Existing translations belong to the old language/engine/scope; redo them with the new choice.
    const outdated =
      settings.targetLang !== this.settings.targetLang || settings.engine !== this.settings.engine || settings.scope !== this.settings.scope;
    const uiLangChanged = settings.uiLang !== this.settings.uiLang;
    this.settings = settings;
    if (this.doc.getElementById('yilin-translate-style')) applyStyle(this.doc, settings);
    // Error notes on the page are UI text: show them in the newly chosen interface language.
    if (uiLangChanged && !outdated) for (const s of this.segments.values()) if (s.status === 'failed') this.renderError(s);
    if (outdated && (this.active || this.stopped)) {
      const wasActive = this.active;
      this.restore();
      if (wasActive) this.start();
    }
  }

  private halt(): void {
    this.active = false;
    this.generation++;
    this.queue = [];
    this.inflight = 0;
    clearTimeout(this.flushTimer);
    clearTimeout(this.rescanTimer);
    this.visibility?.disconnect();
    this.visibility = undefined;
    this.mutations?.disconnect();
    this.mutations = undefined;
    this.doc.removeEventListener('click', this.onClick, true);
    this.doc.defaultView?.removeEventListener('scroll', this.scheduleSweep);
    this.doc.defaultView?.removeEventListener('resize', this.scheduleSweep);
    clearTimeout(this.sweepTimer);
    this.sweepTimer = undefined;
  }

  private scan(): void {
    for (const [el, s] of this.segments) {
      if (!el.isConnected) {
        this.segments.delete(el);
        this.byId.delete(s.id);
      }
    }
    for (const { el, text, compact } of extractSegments(this.doc.body, this.settings.targetLang, this.settings.scope)) {
      const existing = this.segments.get(el);
      const fp = fingerprint(text);
      if (existing && existing.fp === fp) {
        if (existing.status === 'new') this.visibility?.observe(el);
        else if (!hasTranslation(el)) this.restoreRendering(existing);
        continue;
      }
      if (existing) removeTranslation(el);
      const seg: Segment = existing ?? { id: `y${this.nextId++}`, el, text, fp, status: 'new', compact };
      Object.assign(seg, { text, fp, compact, status: 'new' as const });
      if (!existing) {
        el.setAttribute(SEGMENT_ATTR, seg.id);
        this.segments.set(el, seg);
        this.byId.set(seg.id, seg);
      }
      this.visibility?.observe(el);
    }
  }

  /**
   * Queue the paragraphs inside one container now, beyond what is near the screen. Reading aloud on a phone
   * asks for this: with the screen off the page is in the background, does not scroll and so never translates
   * what lies below, and the reading would end at the last paragraph that happened to be translated.
   * Bounded, so starting to listen to a very long page does not translate all of it.
   */
  translateWithin(root: Element, maxChars = 20_000): void {
    if (!this.active || this.blocked) return;
    let budget = maxChars;
    for (const seg of this.segments.values()) {
      if (seg.status !== 'new' || !seg.el.isConnected || !root.contains(seg.el)) continue;
      if (budget <= 0) break;
      budget -= seg.text.length;
      this.visibility?.unobserve(seg.el);
      this.enqueue(seg);
    }
  }

  private onVisible(el: Element): void {
    const seg = this.segments.get(el);
    this.visibility?.unobserve(el);
    if (seg && seg.status === 'new') this.enqueue(seg);
  }

  /**
   * The observer misses paragraphs on some pages — it never reports an element that had no size
   * when it was observed, which is how a long article can end up with most of it registered but
   * never queued. This sweep enqueues by position instead, so the observer is an optimisation
   * rather than the only path. It reads layout, so it is throttled and skipped when nothing waits.
   */
  private sweep = (): void => {
    this.sweepTimer = undefined;
    if (!this.active || this.blocked) return;
    const height = this.doc.defaultView?.innerHeight ?? 0;
    for (const seg of this.segments.values()) {
      if (seg.status !== 'new') continue;
      if (!seg.el.isConnected) continue;
      const rect = seg.el.getBoundingClientRect();
      if (rect.bottom < -VIEWPORT_MARGIN_PX || rect.top > height + VIEWPORT_MARGIN_PX) continue;
      this.visibility?.unobserve(seg.el);
      this.enqueue(seg);
    }
  };

  private scheduleSweep = (): void => {
    if (this.sweepTimer !== undefined) return;
    this.sweepTimer = setTimeout(this.sweep, this.sweepDelayMs);
  };

  private enqueue(seg: Segment): void {
    seg.status = 'queued';
    renderTranslation(seg.el, { kind: 'loading', label: this.t('page.loading'), lang: this.uiLang }, seg.id, seg.compact);
    this.queue.push(seg);
    this.scheduleFlush();
    this.emit();
  }

  private scheduleFlush(): void {
    if (this.flushTimer === undefined) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined;
        this.flush();
      }, this.flushDelayMs);
    }
  }

  private flush(): void {
    if (this.blocked) return;
    while (this.active && this.queue.length > 0 && this.inflight < this.maxConcurrent) {
      const batch: Segment[] = [];
      let chars = 0;
      while (this.queue.length > 0 && batch.length < MAX_BATCH_SEGMENTS) {
        const next = this.queue[0]!;
        const len = Math.min(next.text.length, MAX_SEGMENT_CHARS);
        if (batch.length > 0 && chars + len > MAX_BATCH_CHARS) break;
        this.queue.shift();
        if (next.status !== 'queued' || !next.el.isConnected) continue;
        batch.push(next);
        chars += len;
      }
      if (batch.length > 0) void this.send(batch);
    }
  }

  /**
   * The terms the page repeats, each translated once on its own, so every paragraph uses the same words for them.
   * Worked out when the first batch is about to go, from every paragraph the page has, and kept for the run.
   */
  private getLocks(): Promise<Map<string, string>> {
    this.locks ??= lockTerms(findRepeatedTerms([...this.segments.values()].map((s) => s.text)), this.settings.targetLang, this.options.translate)
      .catch(() => new Map<string, string>())
      .then((locked) => new Map([...glossaryFor(this.settings.targetLang), ...locked]));
    return this.locks;
  }

  private async send(batch: Segment[]): Promise<void> {
    const generation = this.generation;
    const sent = new Map(batch.map((s) => [s.id, s.fp]));
    batch.forEach((s) => (s.status = 'inflight'));
    this.inflight++;
    let results: SegmentResult[];
    // Names and acronyms travel as placeholders, so the engine cannot translate or expand them.
    const locked = await this.getLocks();
    if (generation !== this.generation) return;
    const protectedText = new Map(batch.map((s) => [s.id, protectTerms(s.text.slice(0, MAX_SEGMENT_CHARS), { cell: !!s.el.closest('table') || s.el.classList.contains('ltx_bibblock'), locked })]));
    try {
      // A segment that is nothing but names ("QNLI", "BiLSTM+ELMo+Attn") has nothing to translate; it is not sent.
      const hasWords = (id: string) => /\p{L}/u.test(protectedText.get(id)!.text.replace(/\[\[T?\d+\]\]/g, ''));
      const toSend = batch.filter((s) => hasWords(s.id));
      const answers: SegmentResult[] = [
        ...batch.filter((s) => !hasWords(s.id)).map((s) => ({ id: s.id, ok: true as const, text: restoreTerms(protectedText.get(s.id)!.text, protectedText.get(s.id)!.terms) })),
        ...(toSend.length > 0
          ? await this.options.translate(toSend.map((s) => ({ id: s.id, text: protectedText.get(s.id)!.text })), this.settings.targetLang)
          : []),
      ];
      // A placeholder the engine swallowed would leave its word out of the sentence, or at its end where it does not
      // belong: those sentences are translated again with the words left in, which is how an engine usually copes.
      const sentIds = new Set(toSend.map((s) => s.id));
      const lost = new Set(answers.filter((r) => sentIds.has(r.id) && r.ok && !termsSurvive(r.text, protectedText.get(r.id)?.terms ?? [])).map((r) => r.id));
      const again = lost.size > 0
        ? await this.options.translate(batch.filter((s) => lost.has(s.id)).map((s) => ({ id: s.id, text: s.text.slice(0, MAX_SEGMENT_CHARS) })), this.settings.targetLang)
        : [];
      const redone = new Map(again.map((r) => [r.id, r]));
      results = answers.map((r) => {
        if (lost.has(r.id)) return redone.get(r.id) ?? r;
        return r.ok && sentIds.has(r.id) ? { ...r, text: restoreTerms(r.text, protectedText.get(r.id)?.terms ?? []) } : r;
      });
    } catch {
      results = batch.map((s) => ({ id: s.id, ok: false, error: 'NETWORK' as const }));
    }
    if (generation !== this.generation) return;
    this.inflight--;
    const answered = new Set<string>();
    for (const result of results) {
      const seg = this.byId.get(result.id);
      if (!seg || !sent.has(result.id) || seg.status !== 'inflight') continue;
      answered.add(result.id);
      this.applyResult(seg, sent.get(result.id)!, result);
    }
    for (const seg of batch) {
      if (!answered.has(seg.id) && seg.status === 'inflight') this.applyResult(seg, seg.fp, { id: seg.id, ok: false, error: 'PROVIDER_UNAVAILABLE' });
    }
    if (this.handleRateLimit(batch, results)) return;
    this.flush();
    this.scheduleSweep();
    this.emit();
  }

  /**
   * The free Google endpoint refuses whole batches once it decides there is too much traffic, and
   * marking every paragraph in red says nothing useful: the page is fine, the service is not.
   * Such a batch is put back and retried after a pause; when that stops helping the page stays as
   * it is and the popup asks the reader to choose another service.
   */
  private handleRateLimit(batch: Segment[], results: SegmentResult[]): boolean {
    const refused = results.every((r) => !r.ok && r.error === 'RATE_LIMITED') && results.length > 0;
    if (!refused) {
      if (results.some((r) => r.ok)) this.rateLimitStrikes = 0;
      return false;
    }
    const wait = this.backoffMs[this.rateLimitStrikes];
    this.rateLimitStrikes++;
    if (wait === undefined) {
      this.blocked = 'RATE_LIMITED';
      // Leave the paragraphs as the reader found them; the popup carries the one message that
      // matters, and translating resumes from scratch once another service is chosen.
      for (const seg of batch) {
        if (seg.status !== 'failed') continue;
        removeTranslation(seg.el);
        seg.status = 'new';
      }
      this.emit();
      return true;
    }
    // Put them back untouched, so a later attempt (or another service) can still translate them.
    for (const seg of batch) {
      if (seg.status !== 'failed') continue;
      removeTranslation(seg.el);
      seg.status = 'queued';
      this.queue.unshift(seg);
    }
    this.emit();
    setTimeout(() => {
      if (this.active && !this.blocked) this.flush();
    }, wait);
    return true;
  }

  private applyResult(seg: Segment, sentFp: string, result: SegmentResult): void {
    // The paragraph changed while we were waiting: this answer is for old text.
    if (!seg.el.isConnected || sentFp !== seg.fp || fingerprint(segmentText(seg.el, this.settings.scope)) !== sentFp) {
      removeTranslation(seg.el);
      seg.status = 'new';
      this.scheduleRescan();
      return;
    }
    if (result.ok) {
      seg.status = 'done';
      seg.translation = result.text;
      // The same words back (a name, a number): showing them twice is noise.
      seg.same = normalizeText(result.text) === normalizeText(seg.text);
      if (seg.same) return removeTranslation(seg.el);
      renderTranslation(seg.el, { kind: 'done', text: result.text, lang: this.settings.targetLang, math: segmentMath(seg.el, this.settings.scope) }, seg.id, seg.compact);
    } else {
      seg.status = 'failed';
      seg.error = result.error;
      this.renderError(seg);
    }
  }

  /**
   * Puts our own node back after the page re-rendered the paragraph and removed it. Without this a
   * finished paragraph keeps its "done" status while showing no translation at all, and nothing ever
   * looks at it again (seen on a news site that rebuilds paragraphs as the reader scrolls).
   */
  private restoreRendering(seg: Segment): void {
    if (seg.same) return;
    if (seg.status === 'done' && seg.translation !== undefined) {
      renderTranslation(seg.el, { kind: 'done', text: seg.translation, lang: this.settings.targetLang, math: segmentMath(seg.el, this.settings.scope) }, seg.id, seg.compact);
    } else if (seg.status === 'failed') {
      this.renderError(seg);
    } else if (seg.status === 'queued' || seg.status === 'inflight') {
      renderTranslation(seg.el, { kind: 'loading', label: this.t('page.loading'), lang: this.uiLang }, seg.id, seg.compact);
    }
  }

  private renderError(seg: Segment): void {
    const message = this.t(`pageError.${seg.error ?? 'PROVIDER_UNAVAILABLE'}` as MessageKey);
    renderTranslation(seg.el, { kind: 'error', message, retryLabel: this.t('page.retry'), lang: this.uiLang }, seg.id, seg.compact);
  }

  private get uiLang() {
    return resolveUiLang(this.settings.uiLang);
  }

  private t(key: MessageKey) {
    return createTranslator(this.uiLang)(key);
  }

  private onClick = (event: Event): void => {
    const target = event.target instanceof Element ? event.target.closest(`[${RETRY_ATTR}]`) : null;
    if (!target || !this.active) return;
    event.preventDefault();
    event.stopPropagation();
    const seg = this.byId.get(target.getAttribute(RETRY_ATTR) ?? '');
    if (seg?.status === 'failed') this.enqueue(seg);
  };

  private onMutations(records: MutationRecord[]): void {
    const isOwn = (node: Node | null) => {
      const el = node instanceof Element ? node : node?.parentElement;
      return !!el?.closest(`[${YILIN_ATTR}]`);
    };
    // Our own nodes: translations, and the wrappers we put around <br>-separated paragraphs.
    const isOurs = (n: Node) => n instanceof Element && (n.hasAttribute(YILIN_ATTR) || n.hasAttribute(LINE_ATTR));
    const relevant = records.some((r) => {
      if (isOwn(r.target)) return false;
      if (r.type === 'childList') return [...r.addedNodes, ...r.removedNodes].some((n) => !isOurs(n));
      return true; // characterData or a class/style/hidden attribute change: may reveal new content.
    });
    if (relevant) this.scheduleRescan();
  }

  private scheduleRescan(): void {
    if (!this.active) return;
    clearTimeout(this.rescanTimer);
    this.rescanTimer = setTimeout(() => {
      if (!this.active) return;
      this.scan();
      this.scheduleSweep();
      this.emit();
    }, this.rescanDelayMs);
  }

  /** Development builds only: what the controller thinks of each paragraph, for diagnosing a page. */
  inspect(): Record<string, unknown>[] {
    return [...this.segments.values()].map((s) => {
      const rect = s.el.getBoundingClientRect();
      return {
        id: s.id,
        status: s.status,
        error: s.error ?? null,
        node: s.el.querySelector('[data-yilin="translation"]')?.getAttribute('data-state') ?? null,
        top: Math.round(rect.top),
        height: Math.round(rect.height),
        connected: s.el.isConnected,
        text: s.text.slice(0, 40),
      };
    });
  }

  private emit(): void {
    this.options.onState?.(this.getState());
  }
}
