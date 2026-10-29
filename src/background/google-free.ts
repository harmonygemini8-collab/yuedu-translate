import type { SegmentInput, SegmentResult } from '../shared/messages';
import type { TargetLang } from '../shared/settings';
import { PlatformError } from './platform-provider';

/**
 * Free Google Translate via the unofficial endpoint used by Google's own web widgets.
 * Called directly from the user's browser (no Yuedu server, no API key).
 * It has no SLA and may change or rate-limit at any time, so every response is parsed defensively.
 */
export const GOOGLE_FREE_ORIGIN = 'https://translate.googleapis.com';
const ENDPOINT = `${GOOGLE_FREE_ORIGIN}/translate_a/single`;
const TIMEOUT_MS = 15_000;
const FALLBACK_CONCURRENCY = 4;

type Fetch = typeof fetch;

/** Response shape: [[["translated chunk", "source chunk", ...], ...], null, "detected-lang", ...] */
function parseTranslation(data: unknown): string {
  if (!Array.isArray(data) || !Array.isArray(data[0])) throw new PlatformError('PROVIDER_UNAVAILABLE');
  return (data[0] as unknown[])
    .map((chunk) => (Array.isArray(chunk) && typeof chunk[0] === 'string' ? chunk[0] : ''))
    .join('');
}

async function request(text: string, targetLang: TargetLang, doFetch: Fetch): Promise<string> {
  const url = `${ENDPOINT}?${new URLSearchParams({ client: 'gtx', sl: 'auto', tl: targetLang, dt: 't' })}`;
  let response: Response;
  try {
    // POST keeps long batches out of the URL length limit.
    response = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams({ q: text }),
      credentials: 'omit',
      // When Google suspects automated traffic it redirects to its captcha page (google.com/sorry).
      // Following that redirect fails with a CORS error that looks like a network failure, so stop at it.
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new PlatformError('NETWORK');
  }
  const redirected = response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400);
  if (redirected || response.status === 429 || response.status === 503) throw new PlatformError('RATE_LIMITED');
  if (!response.ok) throw new PlatformError('PROVIDER_UNAVAILABLE');
  try {
    return parseTranslation(await response.json());
  } catch (err) {
    throw err instanceof PlatformError ? err : new PlatformError('PROVIDER_UNAVAILABLE');
  }
}

async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function translateWithGoogleFree(
  segments: SegmentInput[],
  targetLang: TargetLang,
  doFetch: Fetch = fetch,
): Promise<SegmentResult[]> {
  // Segments are whitespace-normalized (no newlines), so one request per batch joined by
  // newlines is safe; if Google returns a different number of lines, fall back to one request each.
  if (segments.length > 1) {
    const lines = (await request(segments.map((s) => s.text).join('\n'), targetLang, doFetch)).split('\n');
    if (lines.length === segments.length) {
      return segments.map((s, i) => ({ id: s.id, ok: true, text: lines[i]!.trim() }));
    }
  }
  return mapLimited(segments, FALLBACK_CONCURRENCY, async (s): Promise<SegmentResult> => {
    try {
      return { id: s.id, ok: true, text: (await request(s.text, targetLang, doFetch)).trim() };
    } catch (err) {
      if (err instanceof PlatformError && err.code === 'RATE_LIMITED') throw err;
      return { id: s.id, ok: false, error: err instanceof PlatformError ? err.code : 'PROVIDER_UNAVAILABLE' };
    }
  });
}
