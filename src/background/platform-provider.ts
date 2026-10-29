import type { Engine, ErrorCode, LookupEntry, SegmentInput, SegmentResult } from '../shared/messages';
import type { TargetLang } from '../shared/settings';

const KNOWN_ERRORS: readonly ErrorCode[] = [
  'NETWORK', 'RATE_LIMITED', 'PROVIDER_UNAVAILABLE', 'INVALID_REQUEST', 'UNAUTHENTICATED', 'QUOTA_EXCEEDED', 'NOT_CONFIGURED',
  'PLAN_REQUIRED', 'CODE_INVALID',
];

export class PlatformError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode) {
    super(code);
    this.code = code;
  }
}

/** Calls the Yuedu backend; provider API keys never reach the extension. */
export async function translateViaPlatform(options: {
  apiBase: string;
  token: string;
  engine: Engine;
  targetLang: TargetLang;
  segments: SegmentInput[];
  fetch?: typeof fetch;
}): Promise<SegmentResult[]> {
  if (!options.token) throw new PlatformError('UNAUTHENTICATED');
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(`${options.apiBase}/v1/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.token}` },
      body: JSON.stringify({ engine: options.engine, targetLang: options.targetLang, segments: options.segments }),
      // Below Chrome's 30 s limit for a pending fetch in an extension service worker.
      signal: AbortSignal.timeout(28_000),
    });
  } catch {
    throw new PlatformError('NETWORK');
  }

  let body: { ok?: boolean; error?: unknown; results?: unknown };
  try {
    body = await response.json();
  } catch {
    throw new PlatformError('PROVIDER_UNAVAILABLE');
  }
  if (!response.ok || !body.ok) {
    throw new PlatformError(KNOWN_ERRORS.includes(body.error as ErrorCode) ? (body.error as ErrorCode) : 'PROVIDER_UNAVAILABLE');
  }

  const wanted = new Set(options.segments.map((s) => s.id));
  const results = Array.isArray(body.results) ? (body.results as SegmentResult[]) : [];
  return results.filter((r) => r && wanted.has(r.id) && (r.ok ? typeof r.text === 'string' : KNOWN_ERRORS.includes(r.error)));
}

/** One piece of reading aloud: MP3 bytes from the platform's neural voice. */
export async function speakViaPlatform(options: {
  apiBase: string;
  token: string;
  lang: TargetLang;
  text: string;
  fetch?: typeof fetch;
}): Promise<ArrayBuffer> {
  if (!options.token) throw new PlatformError('UNAUTHENTICATED');
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(`${options.apiBase}/v1/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.token}` },
      body: JSON.stringify({ lang: options.lang, text: options.text }),
      signal: AbortSignal.timeout(28_000),
    });
  } catch {
    throw new PlatformError('NETWORK');
  }
  if (!response.ok) {
    let body: { error?: unknown } = {};
    try {
      body = await response.json();
    } catch {
      // No JSON body: report it as the service being unavailable.
    }
    throw new PlatformError(KNOWN_ERRORS.includes(body.error as ErrorCode) ? (body.error as ErrorCode) : 'PROVIDER_UNAVAILABLE');
  }
  if (!(response.headers.get('content-type') ?? '').startsWith('audio/')) throw new PlatformError('PROVIDER_UNAVAILABLE');
  return response.arrayBuffer();
}

/** Dictionary lookup for one selection; VIP only, so a free account comes back as PLAN_REQUIRED. */
export async function lookupViaPlatform(options: {
  apiBase: string;
  token: string;
  targetLang: TargetLang;
  text: string;
  context: string;
  fetch?: typeof fetch;
}): Promise<LookupEntry> {
  if (!options.token) throw new PlatformError('UNAUTHENTICATED');
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(`${options.apiBase}/v1/lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.token}` },
      body: JSON.stringify({ targetLang: options.targetLang, text: options.text, context: options.context }),
      signal: AbortSignal.timeout(28_000),
    });
  } catch {
    throw new PlatformError('NETWORK');
  }

  let body: { ok?: boolean; error?: unknown; entry?: Partial<LookupEntry> };
  try {
    body = await response.json();
  } catch {
    throw new PlatformError('PROVIDER_UNAVAILABLE');
  }
  if (!response.ok || !body.ok || typeof body.entry?.translation !== 'string') {
    throw new PlatformError(KNOWN_ERRORS.includes(body.error as ErrorCode) ? (body.error as ErrorCode) : 'PROVIDER_UNAVAILABLE');
  }
  return { ...body.entry, text: options.text, translation: body.entry.translation, source: 'model' };
}
