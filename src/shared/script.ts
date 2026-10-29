/**
 * Whether a translation is in the language that was asked for, judged by script alone. An engine that cannot do a
 * sentence (or is being refused by a service that answers anyway) hands the original back, and a page of English
 * under "translations" is worse than an error. Only languages with a script of their own can be told apart from
 * Latin text this way; for the rest there is nothing to check.
 */

import type { TargetLang } from './settings';

const HAN = /[\u3400-\u9fff\uf900-\ufaff]/u;
const SCRIPTS: Partial<Record<TargetLang, RegExp>> = {
  'zh-CN': HAN, 'zh-TW': HAN, yue: HAN,
  ja: /[\u3040-\u30ff\u3400-\u9fff]/u,
  ko: /[\uac00-\ud7af\u1100-\u11ff]/u,
  th: /[\u0e00-\u0e7f]/u,
  ru: /[\u0400-\u04ff]/u, uk: /[\u0400-\u04ff]/u, bg: /[\u0400-\u04ff]/u,
  el: /[\u0370-\u03ff]/u,
  he: /[\u0590-\u05ff]/u,
  ar: /[\u0600-\u06ff]/u, fa: /[\u0600-\u06ff]/u, ur: /[\u0600-\u06ff]/u,
  hi: /[\u0900-\u097f]/u, bn: /[\u0980-\u09ff]/u, ta: /[\u0b80-\u0bff]/u,
};

/** Placeholders that stand for formulas, names and inline code are not text of either language. */
const PLACEHOLDER = /\[\[\s*[CT]?\d+\s*\]\]?/gu;
const MIN_SOURCE_LATIN = 12;
const MIN_SHARE = 0.3;

const count = (text: string, pattern: RegExp) => text.match(new RegExp(pattern.source, 'gu'))?.length ?? 0;

/**
 * `false` only when the source was real Latin-script text and the translation is mostly not in the target script.
 * Anything that cannot be judged (a language without its own script, a name, a number) is `true`.
 */
export function looksTranslated(source: string, translation: string, lang: TargetLang): boolean {
  const script = SCRIPTS[lang];
  if (!script) return true;
  const from = source.replace(PLACEHOLDER, ' ');
  // A single word, a name or a short label may well come back unchanged.
  if (count(from, /[A-Za-z]/u) < MIN_SOURCE_LATIN || !/\s/u.test(from.trim())) return true;
  const to = translation.replace(PLACEHOLDER, ' ');
  const letters = count(to, /\p{L}/u);
  if (letters === 0) return true;
  return count(to, script) / letters >= MIN_SHARE;
}

/**
 * A free hosted model answering with a refusal ("I'm sorry, I can't help with that") instead of a translation —
 * seen on politically sensitive paragraphs with some free Chinese models (doc/24 §2, reported by users of a
 * competing extension whose vendor confirmed the behavior; not reproduced on our own free engines yet, but the
 * same free models are used elsewhere). Written out as fixed phrases, not detected by the target engine, since
 * a refusal is itself in whichever language the model chose to refuse in.
 */
const REFUSAL_PHRASES = [
  /\bi'?m sorry,? (but )?i (can'?t|cannot|am not able to)\b/iu,
  /\bi cannot (assist|help|comply|translate|provide)\b/iu,
  /\bas an ai (language model|assistant)\b/iu,
  /\bi'?m not able to (help|assist) with (that|this)\b/iu,
  /很抱歉[，,]?\s*(我)?(还)?(未学习到|无法|不能|不方便)/u,
  /抱歉[，,]?\s*(我)?(无法|不能)(协助|回答|翻译|提供)/u,
  /我(无法|不能)(协助|提供|翻译)(这|此)/u,
  /作为(一个)?(人工智能|AI)(语言模型|助手)/iu,
  /对不起[，,]?\s*(我)?(无法|不能)/u,
];

/** Whether the whole answer is a refusal rather than a translation, so the fallback chain tries the next engine. */
export function looksRefused(translation: string): boolean {
  const text = translation.trim();
  if (text === '') return false;
  return REFUSAL_PHRASES.some((p) => p.test(text));
}
