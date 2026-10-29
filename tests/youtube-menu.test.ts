import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createYoutubeMenu, isYoutubeHost, type YoutubeMenu } from '../src/content/youtube-menu';
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/settings';

const wait = (ms = 350) => new Promise((r) => setTimeout(r, ms));
const panel = () => document.getElementById('yilin-yt-menu')?.shadowRoot ?? null;
const button = () => document.querySelector<HTMLButtonElement>('.yilin-yt-button');

describe('YouTube player button and menu (FR-19)', () => {
  let menu: YoutubeMenu | undefined;
  let settings: Settings;
  let active = false;
  const deps = () => ({
    doc: document,
    getSettings: () => settings,
    isActive: () => active,
    setActive: vi.fn((on: boolean) => {
      active = on;
      menu?.refresh();
    }),
    setSettings: vi.fn((patch: Partial<Settings>) => {
      settings = { ...settings, ...patch };
      menu?.refresh();
    }),
    resetPosition: vi.fn(),
  });

  beforeEach(() => {
    settings = { ...DEFAULT_SETTINGS, uiLang: 'zh-CN' };
    active = false;
    document.body.innerHTML = '<div class="html5-video-player"><div class="ytp-right-controls"><div class="ytp-right-controls-left"><button class="ytp-subtitles-button"></button><button class="ytp-settings-button"></button></div><div class="ytp-right-controls-right"></div></div></div>';
  });
  afterEach(() => menu?.destroy());

  it('recognises the YouTube hosts', () => {
    expect(isYoutubeHost('www.youtube.com')).toBe(true);
    expect(isYoutubeHost('youtube.com')).toBe(true);
    expect(isYoutubeHost('www.youtube-nocookie.com')).toBe(true);
    expect(isYoutubeHost('notyoutube.com')).toBe(false);
    expect(isYoutubeHost('example.com')).toBe(false);
  });

  it('puts the button right before the captions button, with the extension name as its label', () => {
    menu = createYoutubeMenu(deps());
    expect(button()!.nextElementSibling).toBe(document.querySelector('.ytp-subtitles-button'));
    expect(button()!.getAttribute('aria-label')).toBe('阅渡字幕翻译');
    expect(button()!.getAttribute('aria-pressed')).toBe('false');
  });

  it('puts the button back when the player rebuilds its controls', async () => {
    menu = createYoutubeMenu(deps());
    button()!.remove();
    await wait();
    expect(button()).not.toBeNull();
  });

  it('opens a menu with the subtitle features and closes it on a click elsewhere', () => {
    menu = createYoutubeMenu(deps());
    expect(panel()).toBeNull();
    button()!.click();
    const labels = [...panel()!.querySelectorAll('.title, .row span, .modes button, .row')].map((n) => n.textContent);
    expect(labels).toContain('开启字幕翻译');
    expect(labels).toContain('双语对照');
    expect(labels).toContain('仅译文');
    expect(labels).toContain('恢复字幕位置');
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(document.getElementById('yilin-yt-menu')).toBeNull();
  });

  it('switches subtitle translation on and off, and the button shows which', () => {
    const d = deps();
    menu = createYoutubeMenu(d);
    button()!.click();
    const toggle = () => panel()!.querySelector<HTMLButtonElement>('[role="menuitemcheckbox"]')!;
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    toggle().click();
    expect(d.setActive).toHaveBeenLastCalledWith(true);
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    expect(button()!.getAttribute('aria-pressed')).toBe('true');
    toggle().click();
    expect(d.setActive).toHaveBeenLastCalledWith(false);
  });

  it('changes bilingual or translation only, the two colours, and resets the position', () => {
    const d = deps();
    menu = createYoutubeMenu(d);
    button()!.click();
    expect(panel()!.querySelector('[data-mode="bilingual"]')!.getAttribute('aria-pressed')).toBe('true');
    panel()!.querySelector<HTMLButtonElement>('[data-mode="translation"]')!.click();
    expect(d.setSettings).toHaveBeenLastCalledWith({ displayMode: 'translation' });
    expect(panel()!.querySelector('[data-mode="translation"]')!.getAttribute('aria-pressed')).toBe('true');

    const colour = panel()!.querySelector<HTMLInputElement>('input[data-setting="subtitleBackground"]')!;
    expect(colour.value).toBe(DEFAULT_SETTINGS.subtitleBackground);
    colour.value = '#ffd400';
    colour.dispatchEvent(new Event('change'));
    expect(d.setSettings).toHaveBeenLastCalledWith({ subtitleBackground: '#ffd400' });

    panel()!.querySelector<HTMLButtonElement>('[data-action="reset"]')!.click();
    expect(d.resetPosition).toHaveBeenCalledTimes(1);
  });

  it('on the phone site, goes into the top control bar after its own captions button and opens downward', () => {
    // m.youtube.com keeps its controls outside the player element, with a captions button of its own.
    document.body.innerHTML = `
      <div class="player-container"><div class="html5-video-player"></div>
        <ytm-watch-player-controls><div class="player-controls-top">
          <player-autonav-toggle></player-autonav-toggle>
          <yt-closed-captions-toggle-button><ytm-closed-captioning-button><button class="ytmClosedCaptioningButtonButton" aria-pressed="true"></button></ytm-closed-captioning-button></yt-closed-captions-toggle-button>
          <div><button class="icon-button player-settings-icon"></button></div>
        </div></ytm-watch-player-controls></div>`;
    menu = createYoutubeMenu(deps());
    const captions = document.querySelector('yt-closed-captions-toggle-button')!;
    expect(captions.nextElementSibling).toBe(button());
    button()!.click();
    const host = document.getElementById('yilin-yt-menu')!;
    expect(host.style.position).toBe('fixed');
    expect(host.style.bottom).toBe('auto');
    expect(panel()!.querySelector('[role="menuitemcheckbox"]')).not.toBeNull();
  });

  it('keeps clicks and keys in the menu away from the player', () => {
    menu = createYoutubeMenu(deps());
    const reached = vi.fn();
    document.querySelector('.html5-video-player')!.addEventListener('click', reached);
    document.querySelector('.html5-video-player')!.addEventListener('keydown', reached);
    button()!.click();
    panel()!.querySelector<HTMLButtonElement>('[data-mode="translation"]')!.click();
    panel()!.querySelector('.panel')!.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, composed: true }));
    expect(reached).not.toHaveBeenCalled();
  });

  it('shows its labels in the chosen interface language', () => {
    settings = { ...settings, uiLang: 'en' };
    menu = createYoutubeMenu(deps());
    expect(button()!.getAttribute('aria-label')).toBe('Yuedu subtitle translation');
    button()!.click();
    expect([...panel()!.querySelectorAll('.row span')].map((n) => n.textContent)).toContain('Translate subtitles');
  });

  it('removes everything it added', () => {
    menu = createYoutubeMenu(deps());
    button()!.click();
    menu.destroy();
    expect(button()).toBeNull();
    expect(document.getElementById('yilin-yt-menu')).toBeNull();
  });
});
