/**
 * Our button in YouTube's player control bar, with a small menu of the subtitle features the
 * extension has (FR-19): switch subtitle translation on and off, bilingual or translation only,
 * the translation's colours, and moving the block back under the picture. It sits where the
 * viewer already looks for captions, so starting subtitle translation takes one click.
 *
 * The menu lives in a shadow root inside the player (so it shows in fullscreen and the page's CSS
 * cannot reach it) and every text is written with textContent.
 */

import { createTranslator, resolveUiLang, type MessageKey } from '../shared/i18n';
import { PANEL_STYLE, brandIcon, buildPanel, swallowEvents, type PanelDeps } from './subtitle-panel';

export interface YoutubeMenuDeps extends PanelDeps {
  doc: Document;
}

export interface YoutubeMenu {
  /** Redraws the button and the menu from the current state. */
  refresh(): void;
  destroy(): void;
}

export const isYoutubeHost = (hostname: string) => /(^|\.)youtube(-nocookie)?\.com$/.test(hostname);

const BUTTON_CLASS = 'yilin-yt-button';
const HOST_ID = 'yilin-yt-menu';
export function createYoutubeMenu(deps: YoutubeMenuDeps): YoutubeMenu {
  const { doc } = deps;
  let button: HTMLButtonElement | undefined;
  let host: HTMLElement | undefined;
  let open = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const t = (key: MessageKey) => createTranslator(resolveUiLang(deps.getSettings().uiLang))(key);
  const player = () => doc.querySelector<HTMLElement>('.html5-video-player');
  // The mobile site keeps its controls outside the player element, in its own bar with its own caption button.
  const mobileCaptions = () =>
    doc.querySelector<HTMLElement>('.player-controls-top yt-closed-captions-toggle-button, .player-controls-top ytm-closed-captioning-button');
  let mobile = false;
  const captionsButton = () => player()?.querySelector<HTMLElement>('.ytp-subtitles-button') ?? null;
  // The controls are split into a left and a right group in the current player; older ones have one bar.
  const controls = () =>
    player()?.querySelector<HTMLElement>('.ytp-right-controls-left') ?? player()?.querySelector<HTMLElement>('.ytp-right-controls') ?? null;

  const swallow = swallowEvents;

  function close() {
    open = false;
    host?.remove();
    host = undefined;
    button?.setAttribute('aria-expanded', 'false');
  }

  /** On a phone the bar is at the top, so the menu opens downward from the button, within the screen's edge. */
  function place() {
    if (!host) return;
    const view = doc.defaultView;
    if (mobile && button && view) {
      const rect = button.getBoundingClientRect();
      Object.assign(host.style, {
        position: 'fixed',
        top: `${Math.round(rect.bottom + 8)}px`,
        right: `${Math.max(8, Math.round(view.innerWidth - rect.right))}px`,
        bottom: 'auto',
        zIndex: '2147483000',
      });
    } else {
      Object.assign(host.style, { position: 'absolute', right: '12px', bottom: '64px', zIndex: '2147483000' });
    }
  }

  function render() {
    const settings = deps.getSettings();
    if (button) {
      const label = t('yt.title');
      button.setAttribute('aria-label', label);
      button.setAttribute('title', label);
      button.setAttribute('aria-pressed', String(deps.isActive()));
      // Full colour either way, or the gradient turns grey on the dark bar; "on" is the accent ring.
      const icon = button.firstElementChild as SVGElement | null;
      // The player dims its own buttons at rest (opacity), which is what turned the gradient into a film.
      button.style.setProperty('opacity', '1', 'important');
      if (icon) {
        icon.style.setProperty('opacity', '1', 'important');
        icon.style.borderRadius = '6px';
        icon.style.boxShadow = deps.isActive() ? '0 0 0 2px #fcd34d' : 'none';
      }
    }
    if (!open) return;
    const container = mobile ? (doc.fullscreenElement ?? player() ?? doc.body) : player();
    if (!container) return close();
    if (!host) {
      host = doc.createElement('div');
      host.id = HOST_ID;
      host.setAttribute('data-yilin', 'youtube-menu');
      host.attachShadow({ mode: 'open' });
      swallow(host);
      container.append(host);
    }
    place();
    const shadow = host.shadowRoot!;
    const style = doc.createElement('style');
    style.textContent = PANEL_STYLE;
    const panel = buildPanel(doc, deps);
    shadow.replaceChildren(style, panel);
  }

  function openMenu() {
    open = true;
    button?.setAttribute('aria-expanded', 'true');
    render();
  }

  function ensure() {
    timer = undefined;
    const phoneCaptions = mobileCaptions();
    const bar = phoneCaptions ? phoneCaptions.parentElement : controls();
    if (!bar) return;
    if (button?.isConnected && bar.contains(button)) return;
    mobile = !!phoneCaptions;
    button = doc.createElement('button');
    button.className = mobile ? BUTTON_CLASS : `ytp-button ${BUTTON_CLASS}`;
    // The bar's buttons are as tall as the bar; centring the icon in it keeps it level with its neighbours.
    Object.assign(button.style, { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', verticalAlign: 'top' });
    // The phone's bar has no stylesheet for a button it does not know: a touch-sized, plain one.
    if (mobile) Object.assign(button.style, { flex: 'none', width: '44px', height: '44px', padding: '0', border: '0', background: 'none', cursor: 'pointer' });
    button.setAttribute('aria-haspopup', 'true');
    button.setAttribute('aria-expanded', 'false');
    button.append(brandIcon(doc));
    swallow(button);
    button.addEventListener('click', () => (open ? close() : openMenu()));
    // Right beside the captions button, where the viewer already looks for subtitles.
    const captions = captionsButton();
    if (phoneCaptions) phoneCaptions.after(button);
    else if (captions?.parentElement) captions.before(button);
    else bar.prepend(button);
    render();
  }

  // The player is rebuilt when the viewer moves to another video, so the button is put back when it disappears.
  const observer = new MutationObserver(() => {
    if (timer === undefined) timer = setTimeout(ensure, 300);
  });
  observer.observe(doc.documentElement, { childList: true, subtree: true });
  const away = (event: Event) => {
    if (!open) return;
    const target = event.target as Node | null;
    if (target && (host?.contains(target) || button?.contains(target))) return;
    close();
  };
  const escape = (event: KeyboardEvent) => {
    if (open && event.key === 'Escape') close();
  };
  doc.addEventListener('pointerdown', away, true);
  doc.addEventListener('keydown', escape, true);
  ensure();

  return {
    refresh: render,
    destroy() {
      observer.disconnect();
      clearTimeout(timer);
      doc.removeEventListener('pointerdown', away, true);
      doc.removeEventListener('keydown', escape, true);
      close();
      button?.remove();
      button = undefined;
    },
  };
}
