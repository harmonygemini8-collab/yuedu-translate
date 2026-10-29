/**
 * A small badge over the top right of a video, for sites whose player we know nothing about
 * (FR-19). YouTube gets a button in its own control bar; every other player has a control bar of its
 * own shape, so instead of guessing at those, the badge floats over the picture. It shows while the
 * pointer is on (or a finger has touched) a video that has subtitles to translate, and opens the same
 * menu as YouTube's button.
 *
 * It lives in a shadow root (page CSS cannot reach it, and it shows in fullscreen when put inside the
 * fullscreen element), and every text is written with textContent.
 */

import { createTranslator, resolveUiLang } from '../shared/i18n';
import { PANEL_STYLE, brandIcon, buildPanel, swallowEvents, type PanelDeps } from './subtitle-panel';

export interface VideoBadgeDeps extends PanelDeps {
  doc: Document;
  /** Whether this video has subtitles (a text track or a caption element) the translator can read. */
  hasSource(video: HTMLVideoElement): boolean;
  /** How long the badge stays after the pointer last moved over the video. */
  hideMs?: number;
}

export interface VideoBadge {
  /** Redraws the badge and an open menu from the current state. */
  refresh(): void;
  destroy(): void;
}

const HOST_ID = 'yilin-video-badge';
const MIN_VIDEO_WIDTH = 240;
const BADGE = 36;
const EDGE = 8;
const PANEL_WIDTH = 280;
const HIDE_MS = 2500;

const BADGE_STYLE = `
.badge {
  position: fixed; box-sizing: border-box; width: ${BADGE}px; height: ${BADGE}px; padding: 0; border: 0; border-radius: 50%;
  display: flex; align-items: center; justify-content: center; cursor: pointer;
  background: rgba(0, 0, 0, 0.55); box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
}
.badge:hover { background: rgba(0, 0, 0, 0.75); }
.panel { position: fixed; }
`;

export function createVideoBadge(deps: VideoBadgeDeps): VideoBadge {
  const { doc } = deps;
  let host: HTMLElement | undefined;
  let badge: HTMLButtonElement | undefined;
  let target: HTMLVideoElement | undefined;
  let open = false;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  let lastLook = 0;

  const view = () => doc.defaultView;

  /** The largest video with subtitles under the pointer. */
  function videoAt(x: number, y: number): HTMLVideoElement | undefined {
    let best: HTMLVideoElement | undefined;
    let bestArea = 0;
    for (const video of doc.querySelectorAll('video')) {
      const rect = video.getBoundingClientRect?.();
      if (!rect || rect.width < MIN_VIDEO_WIDTH) continue;
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;
      if (rect.width * rect.height <= bestArea || !deps.hasSource(video)) continue;
      [best, bestArea] = [video, rect.width * rect.height];
    }
    return best;
  }

  function hide() {
    clearTimeout(hideTimer);
    hideTimer = undefined;
    open = false;
    host?.remove();
    host = undefined;
    badge = undefined;
  }

  function schedule() {
    clearTimeout(hideTimer);
    if (!open) hideTimer = setTimeout(hide, deps.hideMs ?? HIDE_MS);
  }

  function position() {
    const w = view();
    if (!host || !badge || !target || !w) return;
    const rect = target.getBoundingClientRect();
    if (rect.width < MIN_VIDEO_WIDTH) return hide();
    const left = Math.max(EDGE, Math.min(rect.right - EDGE - BADGE, w.innerWidth - EDGE - BADGE));
    const top = Math.max(EDGE, Math.min(rect.top + EDGE, w.innerHeight - EDGE - BADGE));
    Object.assign(badge.style, { left: `${Math.round(left)}px`, top: `${Math.round(top)}px` });
    const panel = host.shadowRoot!.querySelector<HTMLElement>('.panel');
    if (panel) {
      Object.assign(panel.style, {
        left: `${Math.round(Math.max(EDGE, Math.min(left + BADGE - PANEL_WIDTH, w.innerWidth - EDGE - PANEL_WIDTH)))}px`,
        top: `${Math.round(top + BADGE + EDGE)}px`,
      });
    }
  }

  function render() {
    if (!target) return;
    const container = doc.fullscreenElement && doc.fullscreenElement.tagName !== 'VIDEO' ? doc.fullscreenElement : doc.body;
    if (host && host.parentElement !== container) container.append(host);
    if (!host) {
      host = doc.createElement('div');
      host.id = HOST_ID;
      host.setAttribute('data-yilin', 'video-badge');
      Object.assign(host.style, { position: 'fixed', left: '0', top: '0', width: '0', height: '0', zIndex: '2147483000' });
      host.attachShadow({ mode: 'open' });
      swallowEvents(host);
      container.append(host);
    }
    const style = doc.createElement('style');
    style.textContent = PANEL_STYLE + BADGE_STYLE;
    badge = doc.createElement('button');
    badge.className = 'badge';
    badge.setAttribute('aria-haspopup', 'true');
    badge.setAttribute('aria-expanded', String(open));
    badge.setAttribute('aria-pressed', String(deps.isActive()));
    const label = createTranslator(resolveUiLang(deps.getSettings().uiLang))('yt.title');
    badge.setAttribute('aria-label', label);
    badge.title = label;
    const icon = brandIcon(doc, 22);
    icon.setAttribute('opacity', deps.isActive() ? '1' : '0.7');
    badge.append(icon);
    badge.addEventListener('click', () => {
      open = !open;
      if (open) clearTimeout(hideTimer);
      else schedule();
      render();
    });
    const parts: Node[] = [style, badge];
    if (open) parts.push(buildPanel(doc, deps));
    host.shadowRoot!.replaceChildren(...parts);
    position();
  }

  function show(video: HTMLVideoElement) {
    target = video;
    render();
    schedule();
  }

  const onPointer = (event: Event) => {
    const pointer = event as PointerEvent;
    if (host?.contains(event.target as Node)) return;
    const now = Date.now();
    // Moving over a page fires constantly; looking for a video each time would cost more than it is worth.
    if (event.type === 'pointermove' && now - lastLook < 150) return;
    lastLook = now;
    // A press anywhere else closes the menu; it must not also redraw it for the video it landed on.
    if (open && event.type === 'pointerdown') return hide();
    const video = videoAt(pointer.clientX, pointer.clientY);
    if (video) show(video);
  };
  const onEscape = (event: KeyboardEvent) => {
    if (open && event.key === 'Escape') hide();
  };
  const reposition = () => position();
  const onFullscreen = () => host && render();

  doc.addEventListener('pointermove', onPointer, { capture: true, passive: true });
  doc.addEventListener('pointerdown', onPointer, { capture: true, passive: true });
  doc.addEventListener('keydown', onEscape, true);
  doc.addEventListener('fullscreenchange', onFullscreen);
  view()?.addEventListener('scroll', reposition, { capture: true, passive: true });
  view()?.addEventListener('resize', reposition, { passive: true });

  return {
    refresh: () => host && render(),
    destroy() {
      hide();
      doc.removeEventListener('pointermove', onPointer, { capture: true });
      doc.removeEventListener('pointerdown', onPointer, { capture: true });
      doc.removeEventListener('keydown', onEscape, true);
      doc.removeEventListener('fullscreenchange', onFullscreen);
      view()?.removeEventListener('scroll', reposition, { capture: true });
      view()?.removeEventListener('resize', reposition);
    },
  };
}
