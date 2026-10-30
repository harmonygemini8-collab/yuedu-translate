/**
 * Real markup captured from https://ar5iv.labs.arxiv.org/html/1706.03762 (2026-10-30): a figure caption
 * (`Figure 1`), a table caption with inline formulas (`Table 1`), and a paragraph that refers to a table
 * by number (`(see Table 3 ... )`). Kept verbatim as regression fixtures for doc/24 §6's first item — figure/
 * table numbering was reviewed and not found broken, but nothing pinned the behavior down before this.
 */
export const ARXIV_FIGURE_CAPTION =
  '<figure id="S3.F1" class="ltx_figure"><img src="/html/1706.03762/assets/Figures/ModalNet-21.png" id="S3.F1.g1" class="ltx_graphics ltx_centering ltx_img_portrait" width="912" height="1344" alt="Refer to caption">\n' +
  '<figcaption class="ltx_caption ltx_centering"><span class="ltx_tag ltx_tag_figure">Figure 1: </span>The Transformer - model architecture.</figcaption>\n' +
  '</figure>';

export const ARXIV_TABLE_CAPTION_AND_CELLS =
  '<figure id="S4.T1" class="ltx_table">\n' +
  '<figcaption class="ltx_caption"><span class="ltx_tag ltx_tag_table">Table 1: </span>\n' +
  'Maximum path lengths, per-layer complexity and minimum number of sequential operations for different layer types. ' +
  '<math id="S4.T1.m5" class="ltx_Math" alttext="n"><semantics><mi>n</mi><annotation encoding="application/x-tex">n</annotation></semantics></math> is the sequence length, ' +
  '<math id="S4.T1.m6" class="ltx_Math" alttext="d"><semantics><mi>d</mi><annotation encoding="application/x-tex">d</annotation></semantics></math> is the representation dimension.</figcaption>\n' +
  '<table id="S4.T1.2" class="ltx_tabular">\n' +
  '<thead class="ltx_thead"><tr><th class="ltx_td ltx_th">Layer Type</th><th class="ltx_td ltx_th">Complexity per Layer</th></tr></thead>\n' +
  '<tbody class="ltx_tbody"><tr>\n' +
  '<th class="ltx_td ltx_th ltx_th_row">Self-Attention</th>\n' +
  '<td class="ltx_td"><math id="S4.T1.m9" class="ltx_Math" alttext="O(n^{2}\\cdot d)"><semantics><mrow><mi>O</mi><mrow><mo>(</mo><mrow><msup><mi>n</mi><mn>2</mn></msup><mo>⋅</mo><mi>d</mi></mrow><mo>)</mo></mrow></mrow><annotation encoding="application/x-tex">O(n^{2}\\cdot d)</annotation></semantics></math></td>\n' +
  '</tr></tbody>\n' +
  '</table>\n' +
  '</figure>';

export const ARXIV_TABLE_CROSS_REFERENCE =
  '<p class="ltx_p">We also experimented with using learned positional embeddings instead, and found that the two versions produced nearly identical results (see Table&nbsp;' +
  '<a href="#S6.T3" title="Table 3 ‣ 6.2 Model Variations ‣ 6 Results ‣ Attention Is All You Need" class="ltx_ref"><span class="ltx_text ltx_ref_tag">3</span></a> row (E)). ' +
  'We chose the sinusoidal version because it may allow the model to extrapolate to sequence lengths longer than the ones encountered during training.</p>';
