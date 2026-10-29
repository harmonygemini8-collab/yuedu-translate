import { beforeEach, describe, expect, it } from 'vitest';
import { extractSegments, fingerprint, insertionPoint, segmentText, shouldTranslate } from '../src/content/extractor';

const texts = () => extractSegments(document.body, 'zh-CN').map((s) => s.text);

describe('extractSegments', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('keeps inline links and code inside one paragraph', () => {
    document.body.innerHTML = '<p>Read the <a href="#">guide</a> and run <code>npm test</code> now.</p>';
    expect(texts()).toEqual(['Read the guide and run npm test now.']);
  });

  it('skips code blocks, form fields, navigation, footer and hidden content', () => {
    document.body.innerHTML = `
      <nav><p>Menu item</p></nav>
      <pre><code>const x = 1;</code></pre>
      <textarea>Draft text</textarea>
      <div contenteditable="true"><p>Editable text</p></div>
      <p hidden>Hidden text</p>
      <p style="display:none">Invisible text</p>
      <p translate="no">Brand name</p>
      <footer><p>Footer text</p></footer>
      <p>Visible paragraph</p>`;
    expect(texts()).toEqual(['Visible paragraph']);
  });

  it('skips text already written in Chinese, numbers and punctuation', () => {
    document.body.innerHTML = '<p>这一段已经是中文。</p><p>123 456</p><p>— —</p><p>Hello world</p>';
    expect(texts()).toEqual(['Hello world']);
  });

  it('treats nested list items as separate segments', () => {
    document.body.innerHTML = '<ul><li>Parent item<ul><li>Child item</li></ul></li></ul>';
    expect(texts()).toEqual(['Parent item', 'Child item']);
    const parent = document.querySelector('li')!;
    expect(insertionPoint(parent)).toBe(parent.querySelector('ul'));
  });

  it('reads text wrapped in display:contents elements, which browsers report as not visible', () => {
    // jsdom has no checkVisibility; this is how Chrome answers (false for display:contents, whose
    // children still render, and for anything inside display:none). UI frameworks wrap whole pages
    // in such elements, and treating them as hidden made the page look empty (lpga.com).
    const original = (Element.prototype as { checkVisibility?: () => boolean }).checkVisibility;
    (Element.prototype as unknown as { checkVisibility: (el?: unknown) => boolean }).checkVisibility = function (this: Element) {
      const style = this.ownerDocument.defaultView!.getComputedStyle(this);
      if (style.display === 'contents' || style.display === 'none' || style.visibility === 'hidden') return false;
      return !this.closest('[data-display-none]');
    };
    try {
      document.body.innerHTML = `
        <span style="display:contents">
          <span style="display:contents">
            <p>Wrapped paragraph</p>
            <div data-display-none style="display:none"><p>Really hidden</p></div>
          </span>
        </span>`;
      expect(texts()).toEqual(['Wrapped paragraph']);
    } finally {
      (Element.prototype as { checkVisibility?: unknown }).checkVisibility = original;
    }
  });

  it('uses a div only when it has loose text of its own', () => {
    document.body.innerHTML = '<div><p>Inner paragraph</p></div><div>Loose <b>div</b> text</div>';
    expect(texts()).toEqual(['Inner paragraph', 'Loose div text']);
  });

  it('treats a div holding only inline elements as one paragraph', () => {
    document.body.innerHTML = '<div class="task"><span>Write the</span> <b>landing page</b></div>';
    expect(texts()).toEqual(['Write the landing page']);
  });

  it('does not let an empty decorative div block a sibling-only-inline paragraph', () => {
    // An icon wrapper or spacer div with no text of its own must not count as a "block descendant"
    // that disqualifies the container — acquire.com wraps a listing's description in bare <span>s
    // next to one such empty <div>, and the whole paragraph went untranslated because of it.
    document.body.innerHTML = '<div class="row"><div class="icon"></div><span>Write the</span> <b>landing page</b></div>';
    expect(texts()).toEqual(['Write the landing page']);
  });

  it('extracts a bare <span> title that sits next to real block siblings its container cannot merge with', () => {
    // A listing page (acquire.com) writes the title as a bare <span>, a sibling to real <div>s
    // (description, price). The container can't merge all three into one paragraph, so without
    // this the span — never itself a candidate tag — carried no fallback and vanished entirely.
    document.body.innerHTML = `
      <div class="container">
        <span class="headline">Profitable ERP software business</span>
        <div class="about">This is a profitable business.</div>
        <div class="price">Asking price $5.5k</div>
      </div>`;
    expect(texts()).toEqual(['Profitable ERP software business', 'This is a profitable business.', 'Asking price $5.5k']);
  });

  it('still merges a <span> sentence fragment when its container can hold the whole paragraph', () => {
    document.body.innerHTML = '<p>Hello <span>world</span>, how are you?</p>';
    expect(texts()).toEqual(['Hello world, how are you?']);
  });

  it('splits a plain-text blob with literal newlines into one segment per line', () => {
    // A listing site (acquire.com) renders a description + checklist as one <span> with `\n`
    // characters and CSS white-space, no <br> at all — each line must translate on its own,
    // not as one undifferentiated paragraph.
    document.body.innerHTML =
      '<div><span class="truncate" style="white-space: pre-line">First paragraph sentence.\n\nSecond paragraph sentence.\n157 modules covering needs.\n3 paying clients.</span></div>';
    expect(texts()).toEqual([
      'First paragraph sentence.',
      'Second paragraph sentence.',
      '157 modules covering needs.',
      '3 paying clients.',
    ]);
    // Restoring (unwrapping the line spans) must put the exact original text back.
    const span = document.querySelector('.truncate')!;
    document.querySelectorAll('[data-yilin-line]').forEach((n) => n.replaceWith(...n.childNodes));
    expect(span.textContent).toBe(
      'First paragraph sentence.\n\nSecond paragraph sentence.\n157 modules covering needs.\n3 paying clients.',
    );
  });

  it('finds the newline blob nested inside a wrapper span that also holds an unrelated toggle button', () => {
    // acquire.com's exact shape: the candidate div wraps a description span, which wraps the text
    // blob span next to a "show more/less" toggle span — a sibling, not a nested line.
    document.body.innerHTML = `
      <div class="about">
        <span class="public-info-block-item__description">
          <span class="text-truncate-wrapper-dynamic" style="white-space: pre-line">First sentence.\n157 modules covering needs.</span>
          <span class="text-truncate-toggle">See less</span>
        </span>
      </div>`;
    expect(texts()).toEqual(['First sentence.', '157 modules covering needs.', 'See less']);
  });

  it('splits a blob that is a span\'s own text beside a toggle child, and keeps the title as its own paragraph', () => {
    // The notifications preview panel: the description text is a direct text node of the span,
    // with the "See less" toggle as a child element next to it, all under one block with a title.
    document.body.innerHTML = `
      <div class="description-block">
        <span class="title">Description</span>
        <span class="description" style="white-space: pre-line">First paragraph here.\n\nSecond paragraph here.\n<span class="toggle">See less</span></span>
      </div>`;
    expect(texts()).toEqual(['Description', 'First paragraph here.', 'Second paragraph here.', 'See less']);
  });

  it('puts the translation after a wrapper\'s own text and before its trailing toggle', () => {
    document.body.innerHTML = `
      <div class="block">
        <span class="title">Reasoning</span>
        <span class="description">Priced at about two times revenue. <span class="toggle">See less</span></span>
      </div>`;
    const toggle = document.querySelector('.toggle')!;
    expect(insertionPoint(document.querySelector('.block')!)).toBe(toggle);
  });

  it('leaves the caption window of a video player alone, which the subtitle feature translates', () => {
    document.body.innerHTML = '<p>Article text.</p><div class="ytp-caption-window-container"><div class="caption-window"><span>This is Anthropic.</span></div></div>';
    expect(texts()).toEqual(['Article text.']);
  });

  it('does not split newlines that the page collapses as ordinary whitespace', () => {
    document.body.innerHTML = '<div><span>Source-wrapped sentence that\nruns over two lines in the HTML.</span></div>';
    expect(texts()).toEqual(['Source-wrapped sentence that runs over two lines in the HTML.']);
  });

  it('skips code-only text, identifiers and link-only menus', () => {
    document.body.innerHTML = `
      <p><code>npm install</code></p>
      <p><kbd>Ctrl</kbd>+<kbd>C</kbd></p>
      <div>pipeline.config.json</div>
      <div><a href="#">Home</a> · <a href="#">About</a> · <a href="#">Contact</a></div>
      <p>Run <code>npm install</code> first.</p>`;
    expect(texts()).toEqual(['Run npm install first.']);
  });

  it('keeps a block whose class name says chrome but whose content is prose', () => {
    // A support ticket's replies sit in "ticket-reply", right next to a "reply" button. Dropping
    // everything named "reply" hid the whole conversation on a hosting provider's ticket page.
    document.body.innerHTML = `
      <div class="ticket-reply">
        <p>Could you confirm whether you would like us to revoke the cancellation request for both plans?</p>
        <div class="reply"><a href="#">Reply</a></div>
      </div>`;
    expect(texts()).toEqual(['Could you confirm whether you would like us to revoke the cancellation request for both plans?']);
  });

  it('finds prose written between <br> elements, not only inside <p>', () => {
    // The provider's ticket system renders a reply as loose text in one div; keying on paragraph
    // tags alone left those replies untranslated while the <p>-shaped ones worked.
    document.body.innerHTML = `
      <div class="ticket-reply">
        <div class="message">Hello,<br><br>We have received your cancellation request and our system will process it shortly.<br><br>Thank You,<br>Andrej</div>
        <div class="reply"><a href="#">Reply</a></div>
      </div>`;
    // One segment per visual paragraph, so each translation lands under the text it belongs to
    // instead of one block after the signature. A lone <br> stays inside its paragraph.
    expect(texts()).toEqual([
      'Hello,',
      'We have received your cancellation request and our system will process it shortly.',
      'Thank You, Andrej',
    ]);
  });

  it('splits a <br> block once, and keeps the same paragraphs on a later pass', () => {
    document.body.innerHTML =
      '<div class="message">First paragraph of the reply.<br><br>Second paragraph of the reply.</div>';
    const first = extractSegments(document.body, 'zh-CN');
    const second = extractSegments(document.body, 'zh-CN');
    expect(second.map((s) => s.el)).toEqual(first.map((s) => s.el));
    expect(second).toHaveLength(2);
  });

  it('leaves a block alone when the breaks do not separate paragraphs', () => {
    document.body.innerHTML = '<div class="message">Flat number 12<br>Hollowbrook Lane, Bristol</div>';
    expect(document.querySelectorAll('[data-yilin-line]')).toHaveLength(0);
    expect(texts()).toEqual(['Flat number 12 Hollowbrook Lane, Bristol']);
  });

  it('skips page chrome identified by class names and ARIA roles', () => {
    document.body.innerHTML = `
      <div class="cookie-banner"><p>We use cookies.</p></div>
      <div class="ad-slot">Sponsored message here</div>
      <div role="toolbar"><div role="button">New task</div></div>
      <div class="header-text">Kept because "header" is not a noise word</div>`;
    expect(texts()).toEqual(['Kept because "header" is not a noise word']);
  });

  it('never discards the main content because of its class name', () => {
    document.body.innerHTML = '<article class="newsletter-post"><p>Article body</p></article>';
    expect(texts()).toEqual(['Article body']);
  });

  it('limits extraction to the main landmark when it holds the content', () => {
    document.body.innerHTML = `
      <header><p>Site tagline for the whole website</p></header>
      <main><p>Main article paragraph with plenty of real content in it.</p></main>
      <aside><p>Sidebar promo</p></aside>`;
    expect(texts()).toEqual(['Main article paragraph with plenty of real content in it.']);
  });

  it('falls back to the whole page when the main landmark is nearly empty', () => {
    document.body.innerHTML = `
      <main><p>Hi</p></main>
      <div class="content"><p>The real article lives outside the main element on this site, which happens.</p></div>`;
    expect(texts()).toEqual(['Hi', 'The real article lives outside the main element on this site, which happens.']);
  });

  it('ignores translation nodes inserted by the extension', () => {
    document.body.innerHTML = '<p>Original <span data-yilin="translation">译文</span></p>';
    expect(segmentText(document.querySelector('p')!)).toBe('Original');
  });
});

describe('helpers', () => {
  it('fingerprints differ when text changes', () => {
    expect(fingerprint('Hello')).toBe(fingerprint('Hello'));
    expect(fingerprint('Hello')).not.toBe(fingerprint('Hello!'));
  });

  it('only filters Chinese text when the target is Chinese', () => {
    expect(shouldTranslate('中文内容', 'zh-CN')).toBe(false);
    expect(shouldTranslate('中文内容', 'ja')).toBe(true);
  });

  it('distinguishes Chinese, Japanese and mixed-language text', () => {
    expect(shouldTranslate('使用 React 和 TypeScript 构建现代化的用户界面。', 'zh-CN')).toBe(false);
    expect(shouldTranslate('日本語の字幕で映画を見るのが好きです。', 'zh-CN')).toBe(true);
    expect(shouldTranslate('Use the word 学习 when you mean to study.', 'zh-CN')).toBe(true);
  });

  it('keeps short sentences ending in punctuation but drops single identifiers', () => {
    expect(shouldTranslate('Done.', 'zh-CN')).toBe(true);
    expect(shouldTranslate('flat()', 'zh-CN')).toBe(false);
    expect(shouldTranslate('example.com', 'zh-CN')).toBe(false);
    expect(shouldTranslate('@oceanlab', 'zh-CN')).toBe(false);
    expect(shouldTranslate('2h', 'zh-CN')).toBe(false);
  });
});
