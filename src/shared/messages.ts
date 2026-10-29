import { isTargetLang, type TargetLang } from './settings.ts';

export const MAX_BATCH_SEGMENTS = 16;
export const MAX_BATCH_CHARS = 4000;
export const MAX_SEGMENT_CHARS = 2000;
/** One spoken piece; the reader sends sentences, not paragraphs. */
export const MAX_SPEAK_CHARS = 500;

export type ErrorCode =
  | 'NETWORK'
  | 'RATE_LIMITED'
  | 'PROVIDER_UNAVAILABLE'
  | 'INVALID_REQUEST'
  | 'UNAUTHENTICATED'
  | 'QUOTA_EXCEEDED'
  | 'NOT_CONFIGURED'
  /** The service is VIP-only and the account has no Pro plan. */
  | 'PLAN_REQUIRED'
  /** Sign-in code wrong, expired or used up. */
  | 'CODE_INVALID'
  /** New sign-ups are paused (doc/17 §2.4); existing accounts can still sign in. */
  | 'REGISTRATION_DISABLED'
  /** Google OAuth exchange failed (bad code, tokeninfo rejected, etc.). */
  | 'OAUTH_FAILED';

/** Services offered by the platform backend. `azure-tts` reads aloud rather than translates; the others translate. `openai` is the standard model, `openai-premium` the high-quality one. */
export const ENGINES = ['microsoft', 'qwen-free', 'glm-free', 'hunyuan-mt', 'google', 'openai', 'openai-premium', 'azure-tts'] as const;
export type Engine = (typeof ENGINES)[number];
/** The engines that translate; `azure-tts` shares the server's quota and logging but takes no translate request. */
export type TranslateEngine = Exclude<Engine, 'azure-tts'>;
export const isEngine = (value: unknown): value is Engine => ENGINES.includes(value as Engine);

export interface SegmentInput {
  id: string;
  text: string;
}

/** Shared by the extension and the backend: both must enforce the same batch limits. */
export function isValidSegments(segments: unknown): segments is SegmentInput[] {
  if (!Array.isArray(segments) || segments.length === 0 || segments.length > MAX_BATCH_SEGMENTS) return false;
  let chars = 0;
  const ids = new Set<string>();
  for (const s of segments as Partial<SegmentInput>[]) {
    if (!s || typeof s.id !== 'string' || s.id.length > 64 || ids.has(s.id)) return false;
    if (typeof s.text !== 'string' || s.text.length === 0 || s.text.length > MAX_SEGMENT_CHARS) return false;
    ids.add(s.id);
    chars += s.text.length;
  }
  return chars <= MAX_BATCH_CHARS;
}

export type SegmentResult = { id: string; ok: true; text: string } | { id: string; ok: false; error: ErrorCode };

export type PageStatus = 'idle' | 'translating' | 'done' | 'stopped';

export interface PageState {
  status: PageStatus;
  total: number;
  translated: number;
  failed: number;
  pending: number;
  /**
   * The service turned the whole page down rather than individual paragraphs — the free Google
   * endpoint rate-limits a long article. Shown once, instead of an error under every paragraph.
   */
  blocked?: 'RATE_LIMITED';
  /** speechSynthesis is currently playing translated text in this tab. */
  speaking?: boolean;
}

export type PageCommand = 'GET_STATE' | 'START' | 'STOP' | 'RESTORE' | 'RETRY_FAILED' | 'TOGGLE' | 'TTS_START' | 'TTS_STOP';

export type ContentRequest = { type: PageCommand };

export type ContentResponse = { ok: true; state: PageState } | { ok: false; error: 'SITE_DISABLED' | 'UNKNOWN_COMMAND' };

export interface TranslateBatchRequest {
  type: 'TRANSLATE_BATCH';
  targetLang: TargetLang;
  segments: SegmentInput[];
}

/** A note from a page script to the background console, for finding out why something does not show on a device. */
export interface DiagnosticMessage {
  type: 'DIAG';
  detail: Record<string, string | number | boolean>;
}

/** Asks the extension to put the caption hook into this page's own JavaScript world (FR-19). */
export interface CaptionHookRequest {
  type: 'CAPTION_HOOK';
}

export type TranslateBatchResponse ={ ok: true; results: SegmentResult[] } | { ok: false; error: ErrorCode };

/** Selection lookup (doc/03 FR-15): the longest selection the bubble will act on. */
export const MAX_LOOKUP_CHARS = 600;
/** Sentence around the selection, sent so the model can explain the word as used here. */
export const MAX_LOOKUP_CONTEXT_CHARS = 600;

/**
 * A selection is treated as a word (dictionary entry) rather than a passage (plain translation)
 * when it is one short token. CJK has no spaces, so it is capped by length instead.
 */
export function isSingleWord(text: string): boolean {
  const word = text.trim();
  if (!word || word.length > 32) return false;
  // Punctuation around the word is fine ("word."), punctuation inside or on its own is not.
  const bare = word.replace(/^[\p{P}]+|[\p{P}]+$/gu, '');
  if (!bare || /[\s\p{P}]/u.test(bare)) return false;
  return !/[　-〿]/u.test(bare);
}

export interface LookupRequest {
  type: 'LOOKUP';
  targetLang: TargetLang;
  /** The selected text, as the user selected it. */
  text: string;
  /** The sentence it sits in; empty when there is none. */
  context: string;
}

export interface LookupSense {
  /** Part of speech, already in the target language (e.g. 名词). */
  pos: string;
  meaning: string;
}

export interface LookupEntry {
  text: string;
  translation: string;
  /** Phonetic spelling (IPA where it applies); words only, and only from the model. */
  phonetic?: string;
  senses?: LookupSense[];
  /** What the word means in the sentence it was selected from. */
  inContext?: string;
  /** Language the selection was written in, as a BCP-47 code, for speech synthesis. */
  sourceLang?: string;
  /** `model` is the VIP dictionary entry; `engine` is the plain translation everyone gets. */
  source: 'engine' | 'model';
}

export type LookupResponse = { ok: true; entry: LookupEntry } | { ok: false; error: ErrorCode };

export function isValidLookup(msg: unknown): msg is LookupRequest {
  const m = msg as Partial<LookupRequest> | null;
  if (!m || m.type !== 'LOOKUP' || typeof m.text !== 'string' || typeof m.context !== 'string') return false;
  if (!isTargetLang(m.targetLang)) return false;
  return m.text.trim().length > 0 && m.text.length <= MAX_LOOKUP_CHARS && m.context.length <= MAX_LOOKUP_CONTEXT_CHARS;
}

/** The content script asks the background to read one piece aloud with the platform's neural voice. */
export interface SpeakRequest {
  type: 'SPEAK';
  lang: TargetLang;
  text: string;
}

/** `audio` is MP3, base64: extension messages carry JSON, not bytes. */
export type SpeakResponse = { ok: true; audio: string } | { ok: false; error: ErrorCode };

export function isValidSpeak(msg: unknown): msg is SpeakRequest {
  const m = msg as Partial<SpeakRequest> | null;
  return !!m && m.type === 'SPEAK' && isTargetLang(m.lang) && typeof m.text === 'string' && m.text.trim().length > 0 && m.text.length <= MAX_SPEAK_CHARS;
}

export interface StateChangedMessage {
  type: 'STATE_CHANGED';
  state: PageState;
}

const PAGE_COMMANDS: readonly string[] = ['GET_STATE', 'START', 'STOP', 'RESTORE', 'RETRY_FAILED', 'TOGGLE', 'TTS_START', 'TTS_STOP'];

export function isContentRequest(msg: unknown): msg is ContentRequest {
  return !!msg && typeof msg === 'object' && PAGE_COMMANDS.includes((msg as { type?: unknown }).type as string);
}

const RESTRICTED_PREFIXES = [
  'chrome://',
  'chrome-extension://',
  'chrome-search://',
  'chrome-untrusted://',
  'devtools://',
  'edge://',
  'about:',
  'view-source:',
  'https://chromewebstore.google.com/',
  'https://chrome.google.com/webstore',
];

export function isRestrictedUrl(url: string | undefined): boolean {
  if (!url) return true;
  if (!/^(https?|file):/i.test(url)) return true;
  return RESTRICTED_PREFIXES.some((p) => url.startsWith(p)) || /\.pdf([?#]|$)/i.test(url);
}
