import { describe, expect, it } from 'vitest';
import { protectTerms, restoreCode, restoreTerms } from '../src/content/protect';

const round = (text: string) => protectTerms(text);

describe('protected terms', () => {
  it('keeps model names, special tokens, arXiv numbers and links out of the translation', () => {
    const { text, terms } = round('We fine-tune BERT_LARGE with [MASK] tokens (arXiv:1810.04805) at https://example.org/a.');
    expect(text).toBe('We fine-tune [[T1]] with [[T2]] tokens ([[T3]]) at [[T4]].');
    expect(terms).toEqual(['BERT_LARGE', '[MASK]', 'arXiv:1810.04805', 'https://example.org/a']);
  });

  it('keeps citations whole, and does not take a year after an ordinary capitalised word', () => {
    expect(round('This follows Peters et al. 2018a closely.').text).toBe('This follows [[T1]] closely.');
    expect(round('The idea (Devlin et al., 2018) is simple.').text).toBe('The idea [[T1]] is simple.');
    expect(round('Since 2018, results have improved a lot here.').text).toBe('Since 2018, results have improved a lot here.');
  });

  it('keeps acronyms in running text, but not in a heading written in capitals', () => {
    expect(round('We use the CSE and CRF layers for the final prediction.').text).toBe('We use the [[T1]] and [[T2]] layers for the final prediction.');
    expect(round('THE NORDIC LEDGER').text).toBe('THE NORDIC LEDGER');
  });

  it('leaves the formula placeholders alone', () => {
    expect(round('where [[1]] is the position of GPT-3 tokens in the sequence').text).toBe('where [[1]] is the position of [[T1]] tokens in the sequence');
  });

  it('puts the terms back, and keeps one the translation dropped', () => {
    const { terms } = round('We fine-tune BERT_LARGE with [MASK] tokens now.');
    expect(restoreTerms('我们用 [[T1]] 和 [[T2]] 微调。', terms)).toBe('我们用 BERT_LARGE 和 [MASK] 微调。');
    expect(restoreTerms('我们用 [[T1]] 微调。', terms)).toBe('我们用 BERT_LARGE 微调。 [MASK]');
  });

  it('leaves an inline-code placeholder alone, same as a formula placeholder', () => {
    expect(round('Run [[C1]] to build GPT-3 locally.').text).toBe('Run [[C1]] to build [[T1]] locally.');
  });
});

describe('inline code placeholders', () => {
  it('puts the code back, tolerant of a mangled bracket, and keeps one the translation dropped', () => {
    expect(restoreCode('运行 [[C1]] 然后 [[C2]]。', ['npm run build:ext', 'npm test'])).toBe('运行 npm run build:ext 然后 npm test。');
    expect(restoreCode('运行 [ [C1]] 然后。', ['npm run build:ext'])).toBe('运行 npm run build:ext 然后。');
    expect(restoreCode('只运行了一个。', ['npm run build:ext'])).toBe('只运行了一个。 npm run build:ext');
  });
});

describe('table cells', () => {
  const cell = (text: string) => protectTerms(text, { cell: true }).text;

  it('keeps names in a cell whole, so nothing is left to translate', () => {
    expect(cell('BiLSTM+ELMo+Attn')).toBe('[[T1]]');
    expect(cell('ESIM+GloVe')).toBe('[[T1]]');
    expect(cell('SST-2')).toBe('[[T1]]');
    expect(cell('QNLI')).toBe('[[T1]]');
    expect(cell('OpenAI GPT')).toBe('[[T1]] [[T2]]');
    expect(cell('BERT[[1]]')).toBe('[[T1]][[1]]');
  });

  it('still translates the words in a cell', () => {
    expect(cell('Human (expert)')).toBe('Human (expert)');
    expect(cell('Test')).toBe('Test');
  });

  it('finds a placeholder the engine wrote with a space between the brackets', () => {
    const { terms } = protectTerms('See BERT_LARGE here now.');
    expect(restoreTerms('见 [ [T1]] 在这里。', terms)).toBe('见 BERT_LARGE 在这里。');
  });
});
