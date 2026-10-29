/**
 * Translations kept on this device, so a page that is opened again, or a paragraph the site repeats, costs no request
 * and no waiting. The key is a hash of engine, language and text: the original text itself is never stored, only
 * its translation. Everything here is on this machine; nothing is sent anywhere for the sake of the cache.
 */

import type { SegmentInput, SegmentResult } from '../shared/messages';

export interface CacheStore {
  get(keys: string[]): Promise<Map<string, string>>;
  put(entries: [string, string][]): Promise<void>;
}

export async function cacheKey(engine: string, lang: string, text: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${engine}\u0000${lang}\u0000${text}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * What the cache has is answered from it, the rest is translated and then kept. A cache that fails (private windows,
 * a full disk) is skipped: translating never depends on it.
 */
export async function translateCached(
  segments: SegmentInput[],
  engine: string,
  lang: string,
  store: CacheStore | null,
  translate: (segments: SegmentInput[]) => Promise<SegmentResult[]>,
  /**
   * What actually answered a segment, when it differs from `engine` (a fallback chain tried another free
   * service). Reads still go by `engine`, the reader's own choice: switching services on without touching the
   * setting must not surface another service's old answer. Writes go by this, so the entry sits where the next
   * read naturally finds it again, and a service's cache never carries another's words under its name.
   */
  engineUsed?: (id: string) => string,
): Promise<SegmentResult[]> {
  if (!store) return translate(segments);
  let keys: string[] = [];
  let hits = new Map<string, string>();
  try {
    keys = await Promise.all(segments.map((s) => cacheKey(engine, lang, s.text)));
    hits = await store.get(keys);
  } catch {
    return translate(segments);
  }
  const textOf = new Map(segments.map((s) => [s.id, s.text]));
  const keyOf = new Map(segments.map((s, i) => [s.id, keys[i]!]));
  const missing = segments.filter((s) => !hits.has(keyOf.get(s.id)!));
  const fresh = missing.length > 0 ? await translate(missing) : [];
  const toKeep = (
    await Promise.all(
      fresh.map(async (r): Promise<[string, string] | null> => {
        if (!r.ok || r.text.trim() === '') return null;
        const usedEngine = engineUsed?.(r.id) ?? engine;
        const key = usedEngine === engine ? keyOf.get(r.id)! : await cacheKey(usedEngine, lang, textOf.get(r.id) ?? '');
        return [key, r.text];
      }),
    )
  ).filter((entry): entry is [string, string] => entry !== null);
  if (toKeep.length > 0) void store.put(toKeep).catch(() => {});
  const byId = new Map(fresh.map((r) => [r.id, r]));
  return segments.map((s) => {
    const cached = hits.get(keyOf.get(s.id)!);
    return cached !== undefined ? { id: s.id, ok: true as const, text: cached } : byId.get(s.id)!;
  });
}
