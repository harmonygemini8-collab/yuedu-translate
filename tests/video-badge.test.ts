import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVideoBadge, type VideoBadge } from '../src/content/video-badge';
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/settings';

const RECT = { left: 100, top: 50, width: 640, height: 360, right: 740, bottom: 410, x: 100, y: 50, toJSON: () => ({}) } as DOMRect;
const SMALL = { ...RECT, width: 120, right: 220 } as DOMRect;
const host = () => document.getElementById('yilin-video-badge');
const shadow = () => host()?.shadowRoot ?? null;
const move = (x: number, y: number) => document.dispatchEvent(new MouseEvent('pointermove', { clientX: x, clientY: y, bubbles: true }));
const press = (x: number, y: number) => document.dispatchEvent(new MouseEvent('pointerdown', { clientX: x, clientY: y, bubbles: true }));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('video badge for players we know nothing about (FR-19)', () => {
  let badge: VideoBadge | undefined;
  let settings: Settings;
  let active = false;
  let hasSource = true;

  const make = (over: { hideMs?: number } = {}) => {
    const deps = {
      doc: document,
      getSettings: () => settings,
      isActive: () => active,
      setActive: vi.fn((on: boolean) => {
        active = on;
        badge?.refresh();
      }),
      setSettings: vi.fn(),
      resetPosition: vi.fn(),
      hasSource: vi.fn(() => hasSource),
      ...over,
    };
    badge = createVideoBadge(deps);
    return deps;
  };

  beforeEach(() => {
    settings = { ...DEFAULT_SETTINGS, uiLang: 'zh-CN' };
    active = false;
    hasSource = true;
    document.body.innerHTML = '<video></video>';
    document.querySelector('video')!.getBoundingClientRect = () => RECT;
  });
  afterEach(() => {
    badge?.destroy();
    badge = undefined;
  });

  it('shows in the top right corner of a video that has subtitles when the pointer is over it', () => {
    make();
    expect(host()).toBeNull();
    move(300, 200);
    const button = shadow()!.querySelector<HTMLElement>('.badge')!;
    expect(button.getAttribute('aria-label')).toBe('阅渡字幕翻译');
    // 36 px wide, 8 px in from the corner of the video (right edge 740, top edge 50).
    expect(button.style.left).toBe('696px');
    expect(button.style.top).toBe('58px');
  });

  it('stays away from a video with no subtitles, from a thumbnail, and from the rest of the page', () => {
    make();
    hasSource = false;
    move(300, 200);
    expect(host()).toBeNull();

    hasSource = true;
    move(50, 20);
    expect(host()).toBeNull();

    document.querySelector('video')!.getBoundingClientRect = () => SMALL;
    move(150, 100);
    expect(host()).toBeNull();
  });

  it('goes away a moment after the pointer stops moving over the video', async () => {
    make({ hideMs: 30 });
    move(300, 200);
    expect(host()).not.toBeNull();
    await wait(60);
    expect(host()).toBeNull();
  });

  it('opens the same menu as YouTube\'s button, and does not hide while it is open', async () => {
    const deps = make({ hideMs: 30 });
    move(300, 200);
    shadow()!.querySelector<HTMLButtonElement>('.badge')!.click();
    const toggle = () => shadow()!.querySelector<HTMLButtonElement>('[role="menuitemcheckbox"]')!;
    expect(toggle().textContent).toBe('开启字幕翻译');
    await wait(60);
    expect(host()).not.toBeNull();

    toggle().click();
    expect(deps.setActive).toHaveBeenLastCalledWith(true);
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    shadow()!.querySelector<HTMLButtonElement>('[data-mode="translation"]')!.click();
    expect(deps.setSettings).toHaveBeenLastCalledWith({ displayMode: 'translation' });
  });

  it('closes the menu and the badge on a press elsewhere', () => {
    make();
    move(300, 200);
    shadow()!.querySelector<HTMLButtonElement>('.badge')!.click();
    expect(shadow()!.querySelector('.panel')).not.toBeNull();
    press(900, 600);
    expect(host()).toBeNull();
  });

  it('shows for a finger that touches the video, which has no pointer to move over it', () => {
    make();
    press(300, 200);
    expect(host()).not.toBeNull();
  });

  it('keeps clicks inside it away from the page', () => {
    make();
    move(300, 200);
    const reached = vi.fn();
    document.body.addEventListener('click', reached);
    shadow()!.querySelector<HTMLButtonElement>('.badge')!.click();
    expect(reached).not.toHaveBeenCalled();
  });

  it('removes everything it added', () => {
    make();
    move(300, 200);
    badge!.destroy();
    expect(host()).toBeNull();
    move(300, 200);
    expect(host()).toBeNull();
  });
});
