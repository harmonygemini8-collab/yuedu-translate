import { describe, expect, it } from 'vitest';
import { extractSegments } from '../src/content/extractor';

describe('extractor performance', () => {
  it('handles a long, deeply nested page', () => {
    const card = (i: number) =>
      `<div class="card"><div class="inner"><div class="body"><h3>Card title ${i}</h3>` +
      `<p>Paragraph ${i} with <a href="#">a link</a> and <em>emphasis</em> to translate.</p>` +
      `<div class="details-row"><span>Label ${i}</span> <span>Value ${i}</span></div></div></div></div>`;
    document.body.innerHTML = `<main>${Array.from({ length: 2000 }, (_, i) => card(i)).join('')}</main>`;

    const start = performance.now();
    const segments = extractSegments(document.body, 'zh-CN');
    const elapsed = performance.now() - start;

    expect(segments).toHaveLength(6000);
    console.log(`Extracted ${segments.length} segments from ${document.body.querySelectorAll('*').length} elements in ${elapsed.toFixed(0)} ms (jsdom)`);
    // Generous limit: this checks that a huge page completes, not jsdom speed. Takes ~3 s
    // locally but several times longer on shared CI runners, beyond Vitest's 5 s default.
  }, 30_000);
});
