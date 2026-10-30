// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { extractSegments } from '../src/content/extractor';
import { ARXIV_FIGURE_CAPTION, ARXIV_TABLE_CAPTION_AND_CELLS, ARXIV_TABLE_CROSS_REFERENCE } from './fixtures/arxiv-table-figure';

/**
 * Regression coverage for doc/24 §6's first item (figure/table numbering) — reviewing the extractor
 * against real captured markup found nothing broken, but nothing pinned the behavior down either.
 * These lock it in.
 */
describe('arXiv HTML (LaTeXML) figure and table numbering', () => {
  it('keeps a figure caption\'s number tag with its caption text, as one segment', () => {
    document.body.innerHTML = ARXIV_FIGURE_CAPTION;
    expect(extractSegments(document.body, 'zh-CN', 'page').map((s) => s.text)).toEqual([
      'Figure 1: The Transformer - model architecture.',
    ]);
  });

  it('keeps a table caption\'s number tag and its formulas together, and translates header/row labels separately', () => {
    document.body.innerHTML = ARXIV_TABLE_CAPTION_AND_CELLS;
    const texts = extractSegments(document.body, 'zh-CN', 'page').map((s) => s.text);
    expect(texts[0]).toBe(
      'Table 1: Maximum path lengths, per-layer complexity and minimum number of sequential operations for different layer types. [[1]] is the sequence length, [[2]] is the representation dimension.',
    );
    expect(texts).toContain('Layer Type');
    expect(texts).toContain('Self-Attention');
    // A cell holding nothing but a formula has nothing to translate, same as any other math-only paragraph.
    expect(texts.some((t) => /^\[\[\d+\]\]$/.test(t))).toBe(false);
  });

  it('keeps a numbered cross-reference ("see Table 3") inside the sentence that refers to it', () => {
    document.body.innerHTML = ARXIV_TABLE_CROSS_REFERENCE;
    expect(extractSegments(document.body, 'zh-CN', 'page').map((s) => s.text)).toEqual([
      'We also experimented with using learned positional embeddings instead, and found that the two versions ' +
      'produced nearly identical results (see Table 3 row (E)). We chose the sinusoidal version because it may ' +
      'allow the model to extrapolate to sequence lengths longer than the ones encountered during training.',
    ]);
  });
});
