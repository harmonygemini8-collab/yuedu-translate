/**
 * Words that must reach the reader as the author wrote them: model and file names, special tokens, arXiv
 * numbers, citations, acronyms. Sent as numbered placeholders and put back afterwards, so an engine cannot
 * "helpfully" translate BERT as 伯特 or expand CSE into a department, and what is left of the sentence is
 * still read as one.
 */

import { lockedPattern } from './terms';

const WORD = String.raw`\p{L}`;

/** Most specific first; a later pattern never sees text an earlier one has already taken. */
const PATTERNS: RegExp[] = [
  /https?:\/\/[^\s)\]>,;]*[^\s)\]>,;.!?:]/gu, // not the full stop that ends the sentence
  /\barXiv:\s?\d{4}\.\d{4,5}(?:v\d+)?/gu,
  /\b10\.\d{4,9}\/[^\s)\]>,;]+/gu,
  /\[(?:MASK|CLS|SEP|PAD|UNK|EOS|BOS)\]/gu,
  // Citations: "(Peters et al., 2018a)", "Devlin et al. 2018", "Vaswani and Shazeer, 2017". A capitalised word and a year
  // alone ("Since 2018") are not one.
  new RegExp(String.raw`\((?:[A-Z]${WORD}+(?: et al\.?| (?:and|&) [A-Z]${WORD}+)?,? \d{4}[a-z]?(?:; )?)+\)`, 'gu'),
  new RegExp(String.raw`\b[A-Z]${WORD}+(?: et al\.?| (?:and|&) [A-Z]${WORD}+),? \(?\d{4}[a-z]?\)?`, 'gu'),
  // Names built like identifiers: BERT_LARGE, GPT-3, BERT-base, RoBERTa, ResNet-50.
  /\b[A-Z][A-Za-z0-9]*_[A-Za-z0-9_]+\b/gu,
  /\b[A-Z]{2,}[a-z]*-[A-Za-z0-9]+\b/gu,
  /\b[A-Z][a-z]+[A-Z][A-Za-z0-9]*\b/gu,
  /\b[A-Z]{2,}[a-z]+[A-Za-z0-9]*\b/gu, // ELMo, SQuAD
  /\b(?:Transformer|Adam|Softmax)s?\b/gu,
];
/**
 * A table cell is a label, not a sentence: "ESIM+GloVe", "SST-2", "QNLI", "BiLSTM+ELMo+Attn" are names, and an engine
 * given one on its own makes something up ("QNLI" became a library). Everything that looks like a name is kept.
 */
const NAME_CHAIN = /\b(?=[A-Za-z0-9+/-]*[A-Z0-9])[A-Za-z]+(?:[-+/][A-Za-z0-9]+)+\b/gu;
const ACRONYM = /\b[A-Z]{2,8}s?\b/gu;
/** Placeholders already in the text: the formulas. */
const TAKEN = /\[\[\d+\]\]/gu;

/** A heading in capitals is not made of acronyms; acronyms are protected only inside running text. */
const hasRunningText = (text: string) => (text.match(/\b[a-z]{2,}\b/g)?.length ?? 0) >= 4;

export interface Protected {
  text: string;
  terms: string[];
}

export const termToken = (n: number) => `[[T${n}]]`;
const TERM_TOKEN = /\[\s*\[\s*T(\d+)\s*\](?:\s*\])?|(?<!\[)\[\s*T(\d+)\s*\]\s*\]/gu;

export function protectTerms(text: string, options: { cell?: boolean; locked?: Map<string, string> } = {}): Protected {
  const terms: string[] = [];
  const take = (match: string, value = match) => {
    terms.push(value);
    return termToken(terms.length);
  };
  // Split around what is already a placeholder, so the patterns see only the sentence's own words.
  const pieces = text.split(new RegExp(`(${TAKEN.source})`, 'u'));
  const patterns = options.cell ? [NAME_CHAIN, ...PATTERNS, ACRONYM] : hasRunningText(text) ? [...PATTERNS, ACRONYM] : PATTERNS;
  // Terms the page repeats come first: they are put back as the one translation chosen for them.
  const locked = options.locked ? lockedPattern(options.locked) : null;
  const lock = (s: string) => (locked ? s.replace(locked, (m) => take(m, options.locked!.get(m))) : s);
  const out = pieces.map((piece, i) => (i % 2 === 1 ? piece : patterns.reduce((s, pattern) => s.replace(pattern, (m) => take(m)), lock(piece))));
  // Numbered in the order the words appear in the sentence, whichever pattern found them.
  const order: string[] = [];
  const renumbered = out.join('').replace(TERM_TOKEN, (_, a?: string, b?: string) => {
    order.push(terms[Number(a ?? b) - 1]!);
    return termToken(order.length);
  });
  return { text: renumbered, terms: order };
}

export function restoreTerms(text: string, terms: string[]): string {
  if (terms.length === 0) return text;
  const used = new Set<number>();
  const restored = text.replace(TERM_TOKEN, (_, a?: string, b?: string) => {
    const n = a ?? b;
    const term = terms[Number(n) - 1];
    if (term === undefined) return '';
    used.add(Number(n));
    return term;
  });
  // A term the translation dropped is put back at the end rather than lost.
  const lost = terms.filter((_, i) => !used.has(i + 1));
  return lost.length > 0 ? `${restored} ${lost.join(' ')}` : restored;
}

/** Whether every placeholder came back. An engine now and then drops one together with the words around it. */
export function termsSurvive(text: string, terms: string[]): boolean {
  const seen = new Set([...text.matchAll(TERM_TOKEN)].map((m) => Number(m[1] ?? m[2])));
  return terms.every((_, i) => seen.has(i + 1));
}
