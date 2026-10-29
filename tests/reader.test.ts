// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { collectReadableText } from '../src/content/reader';

const tr = (text: string, compact = false) =>
  `<span data-yilin="translation" data-state="done" lang="zh-CN"${compact ? ' data-compact' : ''}>${text}</span>`;

describe('collectReadableText', () => {
  it('reads the article title and body, not menus, bylines, links or related rails', () => {
    document.body.innerHTML = `
      <header><nav><a href="/a">AI Race${tr('人工智能竞赛', true)}</a></nav></header>
      <main>
        <div class="tabs" role="tablist"><span>Giant Money Loop${tr('巨大资金循环')}</span></div>
        <article>
          <header>
            <h1>AI's Giant Money Loop${tr('人工智能的巨大资金循环')}</h1>
            <p>A circular funding model${tr('循环融资模式正在加速人工智能的繁荣')}</p>
          </header>
          <div>By Shawn Donnan <time>Oct 13${tr('10 月 13 日')}</time></div>
          <p>If you want to understand${tr('如果您想了解资本流动方式')}</p>
          <p>The parallel for Loudoun${tr('劳登县的相似之处')}</p>
          <aside><p>Related story${tr('相关报道')}</p></aside>
          <ul><li><a href="/x">Another story${tr('另一篇报道')}</a></li></ul>
        </article>
      </main>
      <footer><p>Terms of Service${tr('服务条款')}</p></footer>`;
    const out = collectReadableText(document)!;
    expect(out.text.split('\n')).toEqual([
      '人工智能的巨大资金循环',
      '循环融资模式正在加速人工智能的繁荣',
      '如果您想了解资本流动方式',
      '劳登县的相似之处',
    ]);
    expect(out.lang).toBe('zh-CN');
  });

  it('keeps only the article being read when main holds several', () => {
    document.body.innerHTML = `
      <main>
        <article><p>Short teaser${tr('短预告')}</p></article>
        <article><p>Long one${tr('这是一篇很长很长很长很长的正文段落')}</p><p>More${tr('更多的正文内容在这里继续')}</p></article>
      </main>`;
    expect(collectReadableText(document)!.text).toBe('这是一篇很长很长很长很长的正文段落\n更多的正文内容在这里继续');
  });

  it('without landmarks, skips page chrome', () => {
    document.body.innerHTML = `
      <header><p>Site tagline${tr('网站标语')}</p></header>
      <div><p>Body text${tr('正文内容')}</p></div>`;
    expect(collectReadableText(document)!.text).toBe('正文内容');
  });

  it('returns null when nothing is translated', () => {
    document.body.innerHTML = '<p>Hello</p>';
    expect(collectReadableText(document)).toBeNull();
  });
});
