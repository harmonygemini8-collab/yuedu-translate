/**
 * The word book: words the reader chose to keep from a lookup. Kept on this device only, in the extension's storage; nothing
 * is uploaded and nothing is added without the reader pressing the star. What is stored is the word, its translation and
 * dictionary entry, the sentence it was met in, and the page (address without the query) it came from.
 */

import type { LookupSense } from './messages';
import { DEFAULT_SCHEDULE, isDue, nextSchedule, type Grade, type Schedule } from './srs';

export const VOCAB_KEY = 'vocab';
export const MAX_VOCAB = 2000;

export interface VocabEntry {
  id: string;
  text: string;
  translation: string;
  phonetic?: string;
  senses?: LookupSense[];
  /** The sentence the word was selected in. */
  context?: string;
  /** Where it was read: the page's address without query or fragment. */
  page?: string;
  /** The language the word is written in, when the dictionary entry said so. */
  sourceLang?: string;
  at: number;
  /** Spaced-repetition schedule; absent only on an entry written before this existed, read back as "due now". */
  schedule?: Schedule;
}

const clip = (value: unknown, max: number) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined);

const sanitizeSchedule = (value: unknown, fallback: Schedule): Schedule => {
  const r = (value && typeof value === 'object' ? value : {}) as Partial<Record<keyof Schedule, unknown>>;
  const num = (v: unknown, min: number, max: number, back: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : back);
  return {
    due: num(r.due, 0, Number.MAX_SAFE_INTEGER, fallback.due),
    interval: num(r.interval, 0, 36500, fallback.interval),
    ease: num(r.ease, 1.3, 3, fallback.ease),
    reps: num(r.reps, 0, 100000, fallback.reps),
  };
};

/** Storage can be written by any extension page; read it as untrusted. */
export function sanitizeVocab(input: unknown): VocabEntry[] {
  if (!Array.isArray(input)) return [];
  const out: VocabEntry[] = [];
  for (const raw of input) {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof VocabEntry, unknown>>;
    const text = clip(r.text, 200);
    const translation = clip(r.translation, 500);
    if (!text || !translation || typeof r.id !== 'string' || typeof r.at !== 'number') continue;
    const senses = (Array.isArray(r.senses) ? r.senses : []).flatMap((s: { pos?: unknown; meaning?: unknown } | null) =>
      clip(s?.pos, 40) && clip(s?.meaning, 200) ? [{ pos: clip(s?.pos, 40)!, meaning: clip(s?.meaning, 200)! }] : []);
    out.push({
      id: r.id.slice(0, 64), text, translation, phonetic: clip(r.phonetic, 100), senses: senses.length ? senses.slice(0, 5) : undefined,
      context: clip(r.context, 500), page: clip(r.page, 300), sourceLang: clip(r.sourceLang, 20), at: r.at,
      schedule: sanitizeSchedule(r.schedule, DEFAULT_SCHEDULE(r.at)),
    });
  }
  return out.slice(0, MAX_VOCAB);
}

export async function loadVocab(): Promise<VocabEntry[]> {
  return sanitizeVocab((await chrome.storage.local.get(VOCAB_KEY))[VOCAB_KEY]);
}

const sameWord = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** `exists`: already in the book (the newest is kept, nothing duplicated); `full`: the book is at its limit. */
export async function saveWord(entry: Omit<VocabEntry, 'id' | 'at' | 'schedule'>, now = Date.now()): Promise<'added' | 'exists' | 'full'> {
  const all = await loadVocab();
  if (all.some((e) => sameWord(e.text, entry.text))) return 'exists';
  if (all.length >= MAX_VOCAB) return 'full';
  // Due immediately: starring a word in the lookup bubble is the only step needed to put it into review.
  const next: VocabEntry = { ...entry, id: `${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`, at: now, schedule: DEFAULT_SCHEDULE(now) };
  await chrome.storage.local.set({ [VOCAB_KEY]: [next, ...all] });
  return 'added';
}

export async function hasWord(text: string): Promise<boolean> {
  return (await loadVocab()).some((e) => sameWord(e.text, text));
}

export async function removeWord(id: string): Promise<void> {
  await chrome.storage.local.set({ [VOCAB_KEY]: (await loadVocab()).filter((e) => e.id !== id) });
}

export async function clearVocab(): Promise<void> {
  await chrome.storage.local.remove(VOCAB_KEY);
}

/** Words due for review now, oldest-due first. */
export function dueWords(entries: VocabEntry[], now = Date.now()): VocabEntry[] {
  return entries.filter((e) => isDue(e.schedule, now)).sort((a, b) => (a.schedule?.due ?? 0) - (b.schedule?.due ?? 0));
}

/** Records one review's outcome and reschedules the word; returns the updated entry, or null if it was deleted meanwhile. */
export async function gradeWord(id: string, grade: Grade, now = Date.now()): Promise<VocabEntry | null> {
  const all = await loadVocab();
  const index = all.findIndex((e) => e.id === id);
  if (index < 0) return null;
  const current = all[index]!;
  const updated: VocabEntry = { ...current, schedule: nextSchedule(current.schedule ?? DEFAULT_SCHEDULE(now), grade, now) };
  all[index] = updated;
  await chrome.storage.local.set({ [VOCAB_KEY]: all });
  return updated;
}

/**
 * The due count on the toolbar icon, so the reader notices without opening the settings page. Updated whenever the
 * word book changes and once when this runs; a word that falls due purely from the clock (no storage write, no
 * extension page opened) does not move it until one of those next happens — there is no background timer for it.
 */
export async function updateVocabBadge(): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.action) return;
  const n = dueWords(await loadVocab()).length;
  await chrome.action.setBadgeText({ text: n > 0 ? String(Math.min(n, 999)) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
}

/**
 * A cell that a spreadsheet would run as a formula (it starts with = + - @, or a tab or return) is made plain text with a
 * leading apostrophe: the words come from web pages, which are not to be trusted with the reader's spreadsheet.
 */
const cell = (value: string | undefined) => {
  const text = (value ?? '').replace(/\r?\n/g, ' ');
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** CSV for a spreadsheet or Anki's import: with a byte order mark so Chinese opens correctly. */
export function toCsv(entries: VocabEntry[]): string {
  const rows = entries.map((e) => [
    e.text, e.phonetic, e.translation, (e.senses ?? []).map((s) => `${s.pos} ${s.meaning}`).join('; '), e.context, e.page, new Date(e.at).toISOString().slice(0, 10),
  ].map(cell).join(','));
  return `﻿${['word,phonetic,translation,meanings,sentence,page,date', ...rows].join('\r\n')}\r\n`;
}

/** Anki's plain-text import treats a tab as the field separator and a line break as the next note: neither may appear inside a field. */
const ankiField = (value: string) => value.replace(/\t/g, ' ').replace(/\r?\n/g, '<br>');

/**
 * Anki-compatible import file: tab-separated, UTF-8, front/back. The `#` header lines are Anki's own convention
 * (recent Anki desktop reads them to preselect the separator, the note type and HTML rendering) so opening
 * File > Import needs no manual field mapping; an older Anki just ignores lines starting with `#`.
 */
export function toAnkiText(entries: VocabEntry[]): string {
  const rows = entries.map((e) => {
    const front = [e.text, e.phonetic ? `<span style="color:#888">${ankiField(e.phonetic)}</span>` : '']
      .filter(Boolean).join(' ');
    const back = [
      ankiField(e.translation),
      (e.senses ?? []).length ? (e.senses ?? []).map((s) => `${ankiField(s.pos)} ${ankiField(s.meaning)}`).join('<br>') : '',
      e.context ? `<i>${ankiField(e.context)}</i>` : '',
    ].filter(Boolean).join('<br>');
    return `${front}\t${back}`;
  });
  const header = ['#separator:tab', '#html:true', '#notetype:Basic', '#columns:Front\tBack'];
  return [...header, ...rows].join('\n') + '\n';
}

/** The address without query or fragment: which page, not which session or which search. */
export function pageOf(href: string): string | undefined {
  try {
    const url = new URL(href);
    return url.protocol === 'http:' || url.protocol === 'https:' ? `${url.origin}${url.pathname}` : undefined;
  } catch {
    return undefined;
  }
}
