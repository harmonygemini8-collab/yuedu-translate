// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { extractSegments } from '../src/content/extractor';
import { BERT_ABSTRACT_WITH_CITATION, BERT_GLUE_TABLE_HEADER, BERT_SUBSCRIPT_WITH_ABBREVIATION } from './fixtures/arxiv-bert';

/**
 * Regression coverage for doc/24 §5's "待补" item: a fixed set of real paper excerpts (here, BERT), asserted
 * against formula count, abbreviation handling and citation non-duplication, as that section asks for.
 */
describe('BERT paper excerpts (real ar5iv markup)', () => {
  it('reads the bolded-letter acronym and the citation as one sentence, not duplicated', () => {
    document.body.innerHTML = BERT_ABSTRACT_WITH_CITATION;
    const [segment] = extractSegments(document.body, 'zh-CN', 'page');
    expect(segment?.text).toBe(
      'We introduce a new language representation model called BERT, which stands for Bidirectional Encoder ' +
      'Representations from Transformers. Unlike recent language representation models Peters et al. 2018a; ' +
      'Radford et al. 2018, BERT is designed to pre-train deep bidirectional representations from unlabeled text ' +
      'by jointly conditioning on both left and right context in all layers. As a result, the pre-trained BERT ' +
      'model can be fine-tuned with just one additional output layer to create state-of-the-art models for a wide ' +
      'range of tasks, such as question answering and language inference, without substantial task-specific ' +
      'architecture modifications.',
    );
    // Each citation author/year appears once, not once inside the sentence and again as its own fragment.
    expect(segment?.text.match(/Peters et al\. 2018a/g)).toHaveLength(1);
  });

  it('keeps a formula subscript stuck to the word it modifies ("BERT_BASE"), one placeholder, not dropped', () => {
    document.body.innerHTML = BERT_SUBSCRIPT_WITH_ABBREVIATION;
    const [segment] = extractSegments(document.body, 'zh-CN', 'page');
    expect(segment?.text).toBe(
      'Question: Does BERT really need such a large amount of pre-training (128,000 words/batch * 1,000,000 steps) ' +
      'to achieve high fine-tuning accuracy? Answer: Yes, BERT[[1]] achieves almost 1.0% additional accuracy on ' +
      'MNLI when trained on 1M steps compared to 500k steps.',
    );
    // Exactly the one formula on the page (the BASE subscript); MNLI is plain text, not a formula.
    expect(segment?.text.match(/\[\[\d+\]\]/g)).toHaveLength(1);
  });

  it('turns a GLUE results header row into one segment per cell, without mangling the abbreviations', () => {
    document.body.innerHTML = BERT_GLUE_TABLE_HEADER;
    const texts = extractSegments(document.body, 'zh-CN', 'page').map((s) => s.text);
    expect(texts).toContain('Table 1: GLUE Test results, scored by the evaluation server.');
    for (const label of ['System', 'QQP', 'QNLI', 'SST-2', 'CoLA', 'STS-B', 'MRPC', 'RTE', 'Average', 'Pre-OpenAI SOTA']) {
      expect(texts).toContain(label);
    }
    // "MNLI-(m/mm)" reads as a code-like token ("m/mm" looks like a path) and is skipped rather than sent to an
    // engine that could mangle it — same end result as the other abbreviations, which are sent but protected.
    expect(texts).not.toContain('MNLI-(m/mm)');
    // A row of plain numbers has nothing to translate.
    expect(texts.some((t) => /^\d/.test(t))).toBe(false);
  });
});
