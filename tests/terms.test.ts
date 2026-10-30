import { describe, expect, it } from 'vitest';
import { protectTerms, restoreTerms } from '../src/content/protect';
import { findRepeatedTerms, lockTerms } from '../src/content/terms';

describe('terms the page repeats', () => {
  const page = [
    'We call our attention "Scaled Dot-Product Attention" (Figure 2).',
    'Multi-Head Attention allows the model to jointly attend to information.',
    'The Scaled Dot-Product Attention is computed on a set of queries.',
    'Multi-Head Attention is used in three different ways.',
    'A Masked Language Model is trained once.',
  ];

  it('finds capitalised multi-word terms that come up more than once, longest first', () => {
    expect(findRepeatedTerms(page)).toEqual(['Scaled Dot-Product Attention', 'Multi-Head Attention', 'Attention']);
  });

  it('does not take the first word of a sentence for a part of a term', () => {
    expect(findRepeatedTerms(['The Encoder Stack has six layers.', 'Then The Encoder Stack is repeated.'])).toEqual(['Encoder Stack']);
  });

  it('locks a single capitalised word too, but only once it comes up often enough to read as a name', () => {
    // Twice is not enough on its own — "Decoder" here is as likely an ordinary capitalised mention as a term.
    expect(findRepeatedTerms(['A Decoder block follows.', 'The Decoder reuses the same stack.'])).toEqual([]);
    expect(findRepeatedTerms([
      'A Decoder block follows.', 'The Decoder reuses the same stack.', 'Each Decoder layer has three parts.',
    ])).toEqual(['Decoder']);
  });

  it('does not lock an all-caps abbreviation as a single-word term — that goes through the no-translate list instead', () => {
    expect(findRepeatedTerms(['BERT is a model.', 'BERT is pre-trained.', 'BERT is fine-tuned.'])).toEqual([]);
  });

  it('translates each once and leaves out one the engine failed on or did not change', async () => {
    const locked = await lockTerms(['Multi-Head Attention', 'Encoder Stack', 'Foo Bar'], 'zh-CN', async (segments) => [
      { id: segments[0]!.id, ok: true, text: '多头注意力。' },
      { id: segments[1]!.id, ok: false, error: 'NETWORK' },
      { id: segments[2]!.id, ok: true, text: 'Foo Bar' },
    ]);
    expect([...locked]).toEqual([['Multi-Head Attention', '多头注意力']]);
  });

  it('sends a locked term as a placeholder and puts the one translation back', () => {
    const locked = new Map([['Multi-Head Attention', '多头注意力']]);
    const { text, terms } = protectTerms('We use Multi-Head Attention in three ways, and Multi-Head Attention helps.', { locked });
    expect(text).toBe('We use [[T1]] in three ways, and [[T2]] helps.');
    expect(restoreTerms('我们使用 [[T1]] 的方式有三种，而 [[T2]] 很有帮助。', terms)).toBe('我们使用 多头注意力 的方式有三种，而 多头注意力 很有帮助。');
  });
});

describe('the built-in glossary', () => {
  it('fixes "character-level" for simplified Chinese, in either case, and only there', async () => {
    const { glossaryFor } = await import('../src/content/terms');
    const zh = glossaryFor('zh-CN');
    expect(zh.get('character-level')).toBe('字符级');
    expect(zh.get('Character-level')).toBe('字符级');
    expect(glossaryFor('ja').size).toBe(0);
    const { text, terms } = protectTerms('Character-level language modeling with deeper self-attention.', { locked: zh });
    expect(text).toBe('[[T1]] [[T2]] with deeper [[T3]].');
    expect(restoreTerms('[[T1]][[T2]]，带有更深层的 [[T3]]。', terms)).toBe('字符级语言建模，带有更深层的 自注意力。');
  });
});
