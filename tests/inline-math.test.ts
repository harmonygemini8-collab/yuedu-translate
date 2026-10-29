// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { extractSegments, insertionPoint, segmentMath } from '../src/content/extractor';
import { removeAllTranslations, renderTranslation } from '../src/content/renderer';

const MATHML = (v: string) => `<math><mi>${v}</mi></math>`;

describe('inline formulas', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('sends a placeholder for each formula instead of dropping it', () => {
    document.body.innerHTML = `<p>where ${MATHML('pos')} is the position and ${MATHML('i')} is the dimension.</p>`;
    expect(extractSegments(document.body, 'zh-CN').map((s) => s.text)).toEqual(['where [[1]] is the position and [[2]] is the dimension.']);
  });

  it('treats KaTeX, MathJax and LaTeXML formulas the same way', () => {
    document.body.innerHTML = `<p>With <span class="katex"><span class="katex-mathml">${MATHML('β')}</span><span class="katex-html">β</span></span>, <mjx-container>x</mjx-container> and <span class="ltx_Math">y</span> set, the model trains.</p>`;
    expect(extractSegments(document.body, 'zh-CN').map((s) => s.text)).toEqual(['With [[1]], [[2]] and [[3]] set, the model trains.']);
  });

  it('puts the page formulas back where the translation has the placeholders', () => {
    document.body.innerHTML = `<p>where ${MATHML('pos')} is the position and ${MATHML('i')} is the dimension.</p>`;
    const p = document.querySelector('p')!;
    renderTranslation(p, { kind: 'done', text: '其中 [[1]] 是位置，[[2]] 是维度。', lang: 'zh-CN', math: segmentMath(p) }, 'y1');
    const out = p.querySelector('[data-yilin="translation"]')!;
    expect(out.textContent).toBe('其中 pos 是位置，i 是维度。');
    expect(out.querySelectorAll('math')).toHaveLength(2);
    expect(p.querySelectorAll('math')).toHaveLength(4); // the page's two, and our copies of them
    removeAllTranslations(document);
  });

  it('keeps a formula the translation lost, at the end, and ignores a made-up number', () => {
    document.body.innerHTML = `<p>Use ${MATHML('ε')} here.</p>`;
    const p = document.querySelector('p')!;
    renderTranslation(p, { kind: 'done', text: '在这里使用。[[9]]', lang: 'zh-CN', math: segmentMath(p) }, 'y1');
    const out = p.querySelector('[data-yilin="translation"]')!;
    expect(out.textContent).toBe('在这里使用。 ε');
  });

  it('a paragraph of nothing but a formula is not worth translating', () => {
    document.body.innerHTML = `<p>${MATHML('x')}</p>`;
    expect(extractSegments(document.body, 'zh-CN')).toEqual([]);
  });
});

describe('a reference to a figure inside a sentence', () => {
  it('stays part of the sentence instead of splitting it', () => {
    document.body.innerHTML = '<p>shown in the left and right halves of Figure <a href="#f1"><span class="ltx_text ltx_ref_tag">1</span></a>, respectively. The encoder is a stack.</p>';
    expect(extractSegments(document.body, 'zh-CN').map((s) => s.text)).toEqual([
      'shown in the left and right halves of Figure 1, respectively. The encoder is a stack.',
    ]);
    // The extension reads the whole page, where a stand-alone link is a paragraph of its own.
    expect(extractSegments(document.body, 'zh-CN', 'page').map((s) => s.text)).toEqual([
      'shown in the left and right halves of Figure 1, respectively. The encoder is a stack.',
    ]);
  });
});

describe('a placeholder the engine damaged', () => {
  it('is still found', () => {
    document.body.innerHTML = '<p>the input for position <math><mi>t</mi></math> now.</p>';
    const p = document.querySelector('p')!;
    renderTranslation(p, { kind: 'done', text: '位置输入[3]]的函数 [[ 1 ]] 和 [1]]。', lang: 'zh-CN', math: segmentMath(p) }, 'y1');
    const out = p.querySelector('[data-yilin="translation"]')!;
    expect(out.textContent).not.toContain(']');
    expect(out.querySelectorAll('math')).toHaveLength(1);
    removeAllTranslations(document);
  });
});

describe('arXiv HTML (LaTeXML) paragraphs', () => {
  const para = `<p class="ltx_p">BERT’s architecture is described in <cite class="ltx_cite"><a href="#b1" class="ltx_ref">Vaswani et&nbsp;al. 2017</a></cite> and released in a library.<span class="ltx_note ltx_role_footnote"><sup class="ltx_note_mark">1</sup><span class="ltx_note_outer"><span class="ltx_note_content"><sup class="ltx_note_mark">1</sup> https://github.com/tensorflow/tensor2tensor</span></span></span> We follow <cite class="ltx_cite"><a class="ltx_ref">Peters et&nbsp;al. 2018a</a>; <a class="ltx_ref">Radford et&nbsp;al. 2018</a></cite> closely.</p>`;

  it('reads citations as part of the sentence, and the footnote as its own segment, not duplicated inline', () => {
    document.body.innerHTML = para;
    const found = extractSegments(document.body, 'zh-CN', 'page');
    expect(found.map((s) => s.text)).toEqual([
      'BERT’s architecture is described in Vaswani et al. 2017 and released in a library.[[1]] We follow Peters et al. 2018a; Radford et al. 2018 closely.',
      '[[1]] https://github.com/tensorflow/tensor2tensor',
    ]);
  });

  it('a footnote with a real sentence (ar5iv shows it as a permanent side-note, not a hover tooltip) is translated, not swallowed whole or dropped', () => {
    document.body.innerHTML = `<p class="ltx_p">We scale the dot products by ${MATHML('x')}.<span class="ltx_note ltx_role_footnote"><sup class="ltx_note_mark">1</sup><span class="ltx_note_outer"><span class="ltx_note_content"><sup class="ltx_note_mark">1</sup><span class="ltx_tag ltx_tag_note">1</span>To illustrate why the dot products get large, assume that the components of ${MATHML('q')} and ${MATHML('k')} are independent.</span></span></span> Next sentence here now.</p>`;
    const found = extractSegments(document.body, 'zh-CN', 'page');
    expect(found.map((s) => s.text)).toEqual([
      'We scale the dot products by [[1]].[[2]] Next sentence here now.',
      '[[1]]1To illustrate why the dot products get large, assume that the components of [[2]] and [[3]] are independent.',
    ]);
  });

  it('still treats a link that stands alone in a menu as an item of its own', () => {
    document.body.innerHTML = '<ul><li><a href="/a">Home page</a></li><li><a href="/b">Contact us</a></li></ul>';
    expect(extractSegments(document.body, 'zh-CN', 'page').map((s) => s.text)).toEqual(['Home page', 'Contact us']);
  });
});

describe('a footnote captured from the live ar5iv page (regression for doc/24 §3)', () => {
  it('translates the footnote as its own segment instead of leaving it out', async () => {
    const { ARXIV_FOOTNOTE_PARAGRAPH } = await import('./fixtures/arxiv-footnote');
    document.body.innerHTML = ARXIV_FOOTNOTE_PARAGRAPH;
    const found = extractSegments(document.body, 'zh-CN', 'page');
    expect(found).toHaveLength(2);
    // The main sentence: the formulas and the footnote mark are placeholders, "[3]" is the citation's own literal
    // text (not a formula), and the footnote's own text is gone from here, not duplicated.
    expect(found[0]!.text).toBe(
      'While for small values of [[1]] the two mechanisms perform similarly, additive attention outperforms dot product attention without scaling for larger values of [[2]] [3]. We suspect that for large values of [[3]], the dot products grow large in magnitude, pushing the softmax function into regions where it has extremely small gradients [[4]] . To counteract this effect, we scale the dot products by [[5]].',
    );
    // The footnote itself, with its own formulas kept.
    expect(found[1]!.text).toBe(
      '[[1]] 1 To illustrate why the dot products get large, assume that the components of [[2]] and [[3]] are independent random variables with mean [[4]] and variance [[5]]. Then their dot product, [[6]], has mean [[7]] and variance [[8]].',
    );
  });

  it('puts the sentence\'s own translation after the whole sentence, not in front of a footnote mark partway through it', async () => {
    // Now that the footnote has its own candidate content, a naive insertion-point search finds a "nested
    // paragraph" inside the footnote mark and would put the sentence's translation ahead of the words that
    // follow the mark ("gradients¹. To counteract…"), splitting the sentence in the middle.
    const { ARXIV_FOOTNOTE_PARAGRAPH } = await import('./fixtures/arxiv-footnote');
    document.body.innerHTML = ARXIV_FOOTNOTE_PARAGRAPH;
    const p = document.querySelector('p')!;
    expect(insertionPoint(p)).toBeNull();
    renderTranslation(p, { kind: 'done', text: '译文在这里。', lang: 'zh-CN' }, 'y1');
    const translation = p.querySelector('[data-yilin="translation"]')!;
    // Last child: after the footnote mark and after the tail of the English sentence that follows it, not
    // wedged in between them.
    expect(p.lastElementChild).toBe(translation);
    removeAllTranslations(document);
  });

  it('drops a backref marker ar5iv\'s own stylesheet hides, instead of leaking a stray "1" into the translation', async () => {
    // ar5iv's stylesheet sets `.ltx_tag_note { display: none }` (verified on the live page, 2026-10-29); the
    // fixture has no stylesheet attached, so the rule is reproduced inline here to the same effect.
    const { ARXIV_FOOTNOTE_PARAGRAPH } = await import('./fixtures/arxiv-footnote');
    document.body.innerHTML = ARXIV_FOOTNOTE_PARAGRAPH.replace(
      '<span class="ltx_tag ltx_tag_note">1</span>',
      '<span class="ltx_tag ltx_tag_note" style="display:none">1</span>',
    );
    const [, footnote] = extractSegments(document.body, 'zh-CN', 'page');
    expect(footnote!.text.startsWith('[[1]] To illustrate')).toBe(true);
    expect(footnote!.text).not.toContain('1 To illustrate');
  });
});

describe('reference lists (LaTeXML)', () => {
  const item = (tag: string, authors: string, title: string, venue: string) => `<li class="ltx_bibitem"><span class="ltx_tag ltx_role_refnum ltx_tag_bibitem">${tag}</span>
<span class="ltx_bibblock">${authors}</span>
<span class="ltx_bibblock">${title}</span>
<span class="ltx_bibblock">${venue}</span></li>`;

  it('translates the title and venue of an entry and leaves the authors and the tag as they are', () => {
    document.body.innerHTML = `<ul class="ltx_biblist">${item('Akbik et&nbsp;al. (2018)', 'Alan Akbik, Duncan Blythe, and Roland Vollgraf. 2018.', 'Contextual string embeddings for sequence labeling.', 'In <em class="ltx_emph ltx_font_italic">Proceedings of the 27th International Conference on Computational Linguistics</em>, pages 1638–1649.')}
${item('Ando and Zhang (2005)', 'Rie Kubota Ando and Tong Zhang. 2005.', 'A framework for learning predictive structures.', '<em class="ltx_emph ltx_font_italic">Journal of Machine Learning Research</em>, 6(Nov):1817–1853.')}</ul>`;
    expect(extractSegments(document.body, 'zh-CN', 'page').map((s) => s.text)).toEqual([
      'Contextual string embeddings for sequence labeling.',
      'In Proceedings of the 27th International Conference on Computational Linguistics, pages 1638–1649.',
      'A framework for learning predictive structures.',
      'Journal of Machine Learning Research, 6(Nov):1817–1853.',
    ]);
  });
});
