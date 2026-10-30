/**
 * Real markup captured from https://ar5iv.labs.arxiv.org/html/1810.04805 (2026-10-30, the BERT paper).
 * These are the exact passages doc/24 §3's real-use findings (2026-10-28, from a report file outside the
 * repo) described from memory without the original HTML to hand: BERT's bolded-letter acronym explanation
 * next to a citation, an inline formula next to an abbreviation, and a results table whose header row is
 * nothing but abbreviations. Captured here verbatim so the regression suite doc/24 §5 asks for ("待补") can
 * assert against the real thing instead of a hand-written approximation.
 */
export const BERT_ABSTRACT_WITH_CITATION =
  '<p id="abstract1.1" class="ltx_p">We introduce a new language representation model called <span id="abstract1.1.1" class="ltx_text ltx_font_bold">BERT</span>, which stands for <span id="abstract1.1.2" class="ltx_text ltx_font_bold">B</span>idirectional <span id="abstract1.1.3" class="ltx_text ltx_font_bold">E</span>ncoder <span id="abstract1.1.4" class="ltx_text ltx_font_bold">R</span>epresentations from <span id="abstract1.1.5" class="ltx_text ltx_font_bold">T</span>ransformers. Unlike recent language representation models&nbsp;<cite class="ltx_cite ltx_citemacro_cite"><a href="#bib.bib36" title="" class="ltx_ref">Peters et&nbsp;al. 2018a</a>; <a href="#bib.bib38" title="" class="ltx_ref">Radford et&nbsp;al. 2018</a></cite>, BERT is designed to pre-train deep bidirectional representations from unlabeled text by jointly conditioning on both left and right context in all layers. As a result, the pre-trained BERT model can be fine-tuned with just one additional output layer to create state-of-the-art models for a wide range of tasks, such as question answering and language inference, without substantial task-specific architecture modifications.</p>';

export const BERT_SUBSCRIPT_WITH_ABBREVIATION =
  '<p id="A3.I1.i1.p1.1" class="ltx_p">Question: Does BERT really need such a large amount of pre-training (128,000 words/batch * 1,000,000 steps) to achieve high fine-tuning accuracy? \n<br class="ltx_break">Answer: Yes, BERT<math id="A3.I1.i1.p1.m1" class="ltx_Math" alttext="{}_{\\textsc{BASE}}"><semantics><msub><mrow></mrow><mtext class="ltx_font_smallcaps">BASE</mtext></msub><annotation encoding="application/x-tex">{}_{\\textsc{BASE}}</annotation></semantics></math> achieves almost 1.0% additional accuracy on MNLI when trained on 1M steps compared to 500k steps.</p>';

export const BERT_GLUE_TABLE_HEADER =
  '<figure id="S3.T1" class="ltx_table">\n' +
  '<figcaption class="ltx_caption ltx_centering"><span class="ltx_tag ltx_tag_table">Table 1: </span>GLUE Test results, scored by the evaluation server.</figcaption>\n' +
  '<table id="S3.T1.2" class="ltx_tabular">\n' +
  '<tbody class="ltx_tbody">\n' +
  '<tr id="S3.T1.2.1" class="ltx_tr">\n' +
  '<th class="ltx_td ltx_th ltx_th_row">System</th>\n' +
  '<td class="ltx_td">MNLI-(m/mm)</td>\n' +
  '<td class="ltx_td">QQP</td>\n' +
  '<td class="ltx_td">QNLI</td>\n' +
  '<td class="ltx_td">SST-2</td>\n' +
  '<td class="ltx_td">CoLA</td>\n' +
  '<td class="ltx_td">STS-B</td>\n' +
  '<td class="ltx_td">MRPC</td>\n' +
  '<td class="ltx_td">RTE</td>\n' +
  '<td class="ltx_td"><span class="ltx_text ltx_font_bold">Average</span></td></tr>\n' +
  '<tr id="S3.T1.2.3" class="ltx_tr">\n' +
  '<th class="ltx_td ltx_th ltx_th_row">Pre-OpenAI SOTA</th>\n' +
  '<td class="ltx_td">80.6/80.1</td>\n' +
  '<td class="ltx_td">66.1</td>\n' +
  '<td class="ltx_td">82.3</td>\n' +
  '<td class="ltx_td">93.2</td>\n' +
  '<td class="ltx_td">35.0</td>\n' +
  '<td class="ltx_td">81.0</td>\n' +
  '<td class="ltx_td">86.0</td>\n' +
  '<td class="ltx_td">61.7</td>\n' +
  '<td class="ltx_td">74.0</td></tr>\n' +
  '</tbody>\n' +
  '</table>\n' +
  '</figure>';
