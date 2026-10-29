import { describe, expect, it } from 'vitest';
import { runBenchmark } from './benchmark';

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

describe('extraction benchmark (NFR-01)', () => {
  const result = runBenchmark();

  it('covers at least 30 annotated pages', () => {
    expect(result.pages.length).toBeGreaterThanOrEqual(30);
  });

  it('reports per-page scores', () => {
    const rows = result.pages.map((p) => ({
      page: p.name,
      precision: p.extracted ? pct(p.truePositives / p.extracted) : '-',
      recall: p.expected ? pct(p.truePositives / p.expected) : '-',
    }));
    console.table(rows);
    for (const p of result.pages) {
      for (const fp of p.falsePositives) console.log(`  FP  ${p.name}: ${fp}`);
      for (const miss of p.missed) console.log(`  MISS ${p.name}: ${miss}`);
    }
    console.log(`Overall precision ${pct(result.precision)} · recall ${pct(result.recall)} · ${result.expected} expected segments`);
  });

  it('meets the 95% precision and recall target', () => {
    expect(result.precision).toBeGreaterThanOrEqual(0.95);
    expect(result.recall).toBeGreaterThanOrEqual(0.95);
  });
});
