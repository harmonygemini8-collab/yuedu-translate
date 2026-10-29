/**
 * The reader's own term list: words they want translated their way every time, for one target language,
 * instead of whatever the engine or the page-wide term-locking (terms.ts) comes up with on its own. Kept on
 * this device only, same storage model as the word book (vocab.ts).
 */

import type { TargetLang } from './settings';

export const GLOSSARY_KEY = 'glossary';
export const MAX_GLOSSARY = 500;
const MAX_TERM_CHARS = 100;
const MAX_TRANSLATION_CHARS = 200;

export interface GlossaryEntry {
  id: string;
  term: string;
  translation: string;
  lang: TargetLang;
  at: number;
}

const clip = (value: unknown, max: number) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined);

/** Storage can be written by any extension page; read it as untrusted. */
export function sanitizeGlossary(input: unknown): GlossaryEntry[] {
  if (!Array.isArray(input)) return [];
  const out: GlossaryEntry[] = [];
  for (const raw of input) {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof GlossaryEntry, unknown>>;
    const term = clip(r.term, MAX_TERM_CHARS);
    const translation = clip(r.translation, MAX_TRANSLATION_CHARS);
    if (!term || !translation || typeof r.id !== 'string' || typeof r.lang !== 'string' || typeof r.at !== 'number') continue;
    out.push({ id: r.id.slice(0, 64), term, translation, lang: r.lang as TargetLang, at: r.at });
  }
  return out.slice(0, MAX_GLOSSARY);
}

export async function loadGlossary(): Promise<GlossaryEntry[]> {
  return sanitizeGlossary((await chrome.storage.local.get(GLOSSARY_KEY))[GLOSSARY_KEY]);
}

const sameTerm = (a: string, b: string, langA: string, langB: string) => langA === langB && a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Adds a term, or replaces the translation of one already in the list for the same language — the reader
 * editing an entry is the same action as adding it the first time, from this list's point of view.
 */
export async function saveTerm(entry: Omit<GlossaryEntry, 'id' | 'at'>, now = Date.now()): Promise<'added' | 'updated' | 'full'> {
  const all = await loadGlossary();
  const index = all.findIndex((e) => sameTerm(e.term, entry.term, e.lang, entry.lang));
  if (index >= 0) {
    all[index] = { ...all[index]!, translation: entry.translation };
    await chrome.storage.local.set({ [GLOSSARY_KEY]: all });
    return 'updated';
  }
  if (all.length >= MAX_GLOSSARY) return 'full';
  const next: GlossaryEntry = { ...entry, id: `${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`, at: now };
  await chrome.storage.local.set({ [GLOSSARY_KEY]: [next, ...all] });
  return 'added';
}

export async function removeTerm(id: string): Promise<void> {
  await chrome.storage.local.set({ [GLOSSARY_KEY]: (await loadGlossary()).filter((e) => e.id !== id) });
}

export async function clearGlossary(): Promise<void> {
  await chrome.storage.local.remove(GLOSSARY_KEY);
}

/** The reader's terms for one target language, as a map ready to merge into the page's term-locking. */
export async function glossaryMapFor(lang: TargetLang): Promise<Map<string, string>> {
  const entries = (await loadGlossary()).filter((e) => e.lang === lang);
  return new Map(entries.map((e) => [e.term, e.translation]));
}
