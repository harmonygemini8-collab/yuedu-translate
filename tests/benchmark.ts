import { LINE_ATTR, extractSegments } from '../src/content/extractor';

const pages = import.meta.glob('./fixtures/pages/*.html', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

export interface PageScore {
  name: string;
  truePositives: number;
  expected: number;
  extracted: number;
  falsePositives: string[];
  missed: string[];
}

const describeEl = (el: Element) => `<${el.tagName.toLowerCase()}> ${(el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 70)}`;

export function scorePage(name: string, html: string): PageScore {
  document.documentElement.innerHTML = html.replace(/^<!doctype html>/i, '');
  // A block that writes its paragraphs with <br> is split into wrappers of ours, one per
  // paragraph. Fixtures annotate the block the page actually has, so each wrapper scores as it.
  const extracted = new Set(
    extractSegments(document.body, 'zh-CN').map((s) => (s.el.hasAttribute(LINE_ATTR) ? s.el.parentElement! : s.el)),
  );
  const expected = [...document.querySelectorAll('[data-expect="yes"]')];
  const neutral = new Set(document.querySelectorAll('[data-expect="any"]'));
  const scored = [...extracted].filter((el) => !neutral.has(el));
  return {
    name,
    truePositives: expected.filter((el) => extracted.has(el)).length,
    expected: expected.length,
    extracted: scored.length,
    falsePositives: scored.filter((el) => el.getAttribute('data-expect') !== 'yes').map(describeEl),
    missed: expected.filter((el) => !extracted.has(el)).map(describeEl),
  };
}

export function runBenchmark() {
  const results = Object.entries(pages)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, html]) => scorePage(path.split('/').pop()!.replace('.html', ''), html));
  const sum = (key: 'truePositives' | 'expected' | 'extracted') => results.reduce((n, r) => n + r[key], 0);
  const tp = sum('truePositives');
  return {
    pages: results,
    precision: tp / sum('extracted'),
    recall: tp / sum('expected'),
    expected: sum('expected'),
  };
}
