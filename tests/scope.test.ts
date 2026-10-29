import { beforeEach, describe, expect, it } from 'vitest';
import { extractSegments, segmentText } from '../src/content/extractor';
import { buildStyle, renderTranslation } from '../src/content/renderer';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../src/shared/settings';

/** Shape of an app dashboard (like the Stripe settings page the user tried). */
const DASHBOARD = `
  <div class="topbar-alert" role="alert">We need some information for your account.</div>
  <nav class="sidebar"><a href="/home">Home</a><a href="/balances">Balances</a><a href="/payments">Payments</a></nav>
  <main>
    <div role="tablist" class="tabs"><a role="tab" href="#a">Account details</a><a role="tab" href="#b">Business details</a></div>
    <form>
      <label for="name">Account name</label>
      <input id="name" value="secret@example.com">
      <div class="field-title">Business address</div>
      <input value="73A Redhill Rd">
      <div class="value"><span>acct_1ULe8Q2K1pZxqRbS</span></div>
      <h3>Phone verification</h3>
      <button type="button">Verify now</button>
      <p>You must verify your phone number via SMS to process payments from the Dashboard.</p>
      <textarea>private note</textarea>
      <pre>const key = 1;</pre>
    </form>
  </main>`;

const texts = (scope: 'article' | 'page') => extractSegments(document.body, 'zh-CN', scope).map((s) => s.text);

describe('translation scope', () => {
  beforeEach(() => {
    document.body.innerHTML = DASHBOARD;
  });

  it('main-text mode still reads only the main text, though it is no longer the default', () => {
    expect(DEFAULT_SETTINGS.scope).toBe('page');
    expect(texts('article')).toEqual([
      'Business address',
      'Phone verification',
      'You must verify your phone number via SMS to process payments from the Dashboard.',
    ]);
  });

  it('whole-page mode also translates menus, tabs, labels, buttons and banners', () => {
    const page = texts('page');
    for (const text of ['We need some information for your account.', 'Home', 'Balances', 'Payments', 'Account details',
      'Business details', 'Account name', 'Business address', 'Phone verification', 'Verify now',
      'You must verify your phone number via SMS to process payments from the Dashboard.']) {
      expect(page, text).toContain(text);
    }
  });

  it('never reads form values, code or identifiers, in either mode', () => {
    for (const scope of ['article', 'page'] as const) {
      const all = texts(scope).join(' | ');
      expect(all).not.toMatch(/secret@example\.com|Redhill|private note|const key|acct_/);
    }
  });

  it('marks interface text as compact only in whole-page mode', () => {
    const page = extractSegments(document.body, 'zh-CN', 'page');
    const compact = (text: string) => page.find((s) => s.text === text)!.compact;
    expect(compact('Home')).toBe(true);
    expect(compact('Verify now')).toBe(true);
    expect(compact('Account name')).toBe(true);
    expect(compact('You must verify your phone number via SMS to process payments from the Dashboard.')).toBe(false);
    expect(extractSegments(document.body, 'zh-CN', 'article').every((s) => !s.compact)).toBe(true);
  });

  it('measures text with the same scope it was extracted with', () => {
    const button = document.querySelector('button')!;
    expect(segmentText(button, 'page')).toBe('Verify now');
  });

  it('puts a menu item translation inline inside the text span, not as an extra item of the flex row', () => {
    document.body.innerHTML = '<nav><a href="/home" style="display:flex"><svg></svg><span>Home</span></a></nav>';
    const [seg] = extractSegments(document.body, 'zh-CN', 'page');
    expect(seg!.el.tagName).toBe('A');
    expect(seg!.compact).toBe(true);
    renderTranslation(seg!.el, { kind: 'done', text: '首页', lang: 'zh-CN' }, 'y1', true);
    const span = document.querySelector('a > span')!;
    expect(span.textContent).toBe('Home首页');
    expect(span.lastElementChild!.getAttribute('data-yilin')).toBe('translation');
    // Rendering again (e.g. loading → done) reuses the same node; removal finds it too.
    renderTranslation(seg!.el, { kind: 'done', text: '主页', lang: 'zh-CN' }, 'y1', true);
    expect(document.querySelectorAll('[data-yilin="translation"]')).toHaveLength(1);
    expect(segmentText(seg!.el, 'page')).toBe('Home');
  });

  it('keeps long text in a sidebar as a normal block translation', () => {
    document.body.innerHTML = '<aside><p>This sidebar paragraph explains how payouts are scheduled every week.</p></aside>';
    expect(extractSegments(document.body, 'zh-CN', 'page')[0]!.compact).toBe(false);
  });

  it('stores the scope safely and renders compact translations inline without the marker line', () => {
    expect(sanitizeSettings({ scope: 'page' }).scope).toBe('page');
    expect(sanitizeSettings({ scope: 'everything' }).scope).toBe('page');
    // The popup no longer offers the choice, so a profile saved before 0.3.4 must not stay on it.
    expect(sanitizeSettings({ scope: 'article' }).scope).toBe('page');
    const button = document.querySelector('button')!;
    renderTranslation(button, { kind: 'done', text: '立即验证', lang: 'zh-CN' }, 'y1', true);
    expect(button.querySelector<HTMLElement>('[data-yilin="translation"]')!.hasAttribute('data-compact')).toBe(true);
    const css = buildStyle(DEFAULT_SETTINGS);
    expect(css).toMatch(/\[data-compact\] \{[^}]*display: inline[^}]*white-space: nowrap[^}]*border: 0/);
  });
});
