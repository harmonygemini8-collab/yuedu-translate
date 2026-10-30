/**
 * One translation per term for the whole page. Paragraphs are sent to the engine one by one, so a term that comes up in
 * fifty of them is translated fifty times, and not always the same way. The terms that repeat are translated once, on
 * their own, and every paragraph then carries them as placeholders that are filled in with that one translation.
 */

import type { SegmentInput, SegmentResult } from '../shared/messages';
import type { TargetLang } from '../shared/settings';

/** A word of a term: Capitalised, or a hyphenated compound of them ("Dot-Product"), or an all-caps abbreviation ("LM"). */
const WORD = String.raw`(?:[A-Z][a-z]+(?:-[A-Z][a-z]+)*|[A-Z]{2,6})`;
const TERM = new RegExp(String.raw`\b${WORD}(?:(?: (?:of|and|for|on|to|in) | )${WORD})+\b`, 'gu');
/** A single Capitalised word on its own ("Transformer"), not an all-caps abbreviation — those go through the
 *  separate no-translate list (FR-28) instead, so a word is not handled by two different mechanisms at once. */
const SINGLE_WORD_TERM = /\b[A-Z][a-z]{2,}\b/gu;
/** Words that begin a sentence, not a term. */
const SENTENCE_STARTERS = new Set(['The', 'A', 'An', 'In', 'We', 'Our', 'This', 'That', 'These', 'Those', 'For', 'It', 'Its', 'On', 'At', 'As', 'If', 'When', 'While', 'Then', 'Each', 'Both', 'All', 'To', 'By', 'With', 'From', 'See', 'Table', 'Figure', 'Section']);

const MIN_COUNT = 2;
/** A lone word is common enough on its own that two chance repeats are not convincing; ask for more before locking it. */
const MIN_COUNT_SINGLE_WORD = 3;
const MAX_TERMS = 40;
const MAX_TERM_CHARS = 60;

/**
 * Terms that appear at least twice, longest first (so "Multi-Head Attention" wins over "Attention"): phrases of
 * two to five Capitalised words, and single Capitalised words (a model or method name, say) repeated often enough
 * that it reads as a name rather than an ordinary capitalised sentence-start. Plain lowercase words are not
 * covered — there is no Capitalisation signal left to tell a term from ordinary prose, and locking an everyday
 * word to one fixed translation risks being wrong in some of the sentences it appears in (doc/24 §6).
 */
export function findRepeatedTerms(texts: string[]): string[] {
  const counts = new Map<string, number>();
  for (const text of texts) {
    for (const match of text.matchAll(TERM)) {
      let term = match[0];
      for (let first = term.split(' ')[0]!; SENTENCE_STARTERS.has(first) && term.includes(' '); first = term.split(' ')[0]!) term = term.slice(first.length + 1);
      if (!term.includes(' ') && !term.includes('-')) continue;
      if (term.split(' ').length > 5 || term.length > MAX_TERM_CHARS) continue;
      counts.set(term, (counts.get(term) ?? 0) + 1);
    }
    for (const match of text.matchAll(SINGLE_WORD_TERM)) {
      const word = match[0];
      if (SENTENCE_STARTERS.has(word)) continue;
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  return [...counts]
    .filter(([term, n]) => n >= (term.includes(' ') ? MIN_COUNT : MIN_COUNT_SINGLE_WORD))
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_TERMS)
    .map(([term]) => term)
    .sort((a, b) => b.length - a.length);
}

/** Each term translated alone; a term the engine fails on, or leaves as it was, is simply not locked. */
export async function lockTerms(
  terms: string[],
  targetLang: TargetLang,
  translate: (segments: SegmentInput[], targetLang: TargetLang) => Promise<SegmentResult[]>,
): Promise<Map<string, string>> {
  const locked = new Map<string, string>();
  if (terms.length === 0) return locked;
  const results = await translate(terms.map((text, i) => ({ id: `g${i}`, text })), targetLang).catch(() => [] as SegmentResult[]);
  for (const r of results) {
    const term = terms[Number(r.id.slice(1))];
    const text = r.ok ? r.text.trim().replace(/[。.!！]+$/u, '') : '';
    if (term !== undefined && text !== '' && text !== term && !/\[\[/.test(text)) locked.set(term, text);
  }
  return locked;
}

export function lockedPattern(locked: Map<string, string>): RegExp | null {
  if (locked.size === 0) return null;
  const escaped = [...locked.keys()].sort((a, b) => b.length - a.length).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(String.raw`(?<![A-Za-z-])(?:${escaped.join('|')})(?![A-Za-z-])`, 'gu');
}

/**
 * Terms a machine translation reliably gets wrong, with the translation Chinese papers use. Written out, not asked for:
 * "Character-level" comes back as "角色级" (the characters of a play) however the sentence is put.
 */
const ACADEMIC_GLOSSARY_ZH: [string, string][] = [
  ['character-level', '字符级'], ['word-level', '词级'], ['subword', '子词'], ['self-attention', '自注意力'],
  ['fine-tuning', '微调'], ['fine-tune', '微调'], ['fine-tuned', '微调后的'], ['pre-training', '预训练'], ['pre-trained', '预训练的'],
  ['pretraining', '预训练'], ['language modeling', '语言建模'], ['language model', '语言模型'], ['word embeddings', '词嵌入'],
  ['hidden state', '隐藏状态'], ['hidden states', '隐藏状态'], ['encoder-decoder', '编码器-解码器'], ['down-stream', '下游'], ['downstream', '下游'],
];

export function glossaryFor(targetLang: TargetLang): Map<string, string> {
  if (targetLang !== 'zh-CN') return new Map();
  const entries: [string, string][] = [];
  for (const [en, zh] of ACADEMIC_GLOSSARY_ZH) entries.push([en, zh], [en[0]!.toUpperCase() + en.slice(1), zh]);
  return new Map(entries);
}
