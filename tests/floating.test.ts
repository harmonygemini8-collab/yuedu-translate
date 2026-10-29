// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFloatingButton, type FloatingActions, type FloatingState } from '../src/content/floating';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../src/shared/settings';
import { createTranslator } from '../src/shared/i18n';

const zh = createTranslator('zh-CN');
const settings = { ...DEFAULT_SETTINGS, uiLang: 'zh-CN' as const };
const idle: FloatingState = { status: 'idle', translated: 0, speaking: false, displayMode: 'bilingual' };

function mount(top?: number | null) {
  const actions: FloatingActions = { toggle: vi.fn(), toggleRead: vi.fn(), toggleMode: vi.fn() };
  const saveTop = vi.fn();
  const api = createFloatingButton(document, { settings, actions, top, saveTop });
  const q = <T extends Element>(selector: string) => api._internals.shadow.querySelector<T>(selector)!;
  return { api, actions, saveTop, q };
}

describe('floating button', () => {
  beforeEach(() => {
    document.querySelectorAll('#yilin-floating').forEach((n) => n.remove());
  });
  afterEach(() => vi.restoreAllMocks());

  it('translates on a tap when nothing is translated, and says so', () => {
    const { actions, q } = mount();
    expect(q<HTMLButtonElement>('.ball').getAttribute('aria-label')).toBe(zh('action.translate'));
    q<HTMLButtonElement>('.ball').click();
    expect(actions.toggle).toHaveBeenCalledTimes(1);
  });

  it('offers to show the original once there is a translation', () => {
    const { api, q } = mount();
    api.update({ ...idle, status: 'done', translated: 5 });
    expect(q<HTMLButtonElement>('.ball').getAttribute('aria-label')).toBe(zh('action.restore'));
    expect(q('.fab').getAttribute('data-status')).toBe('done');
  });

  it('keeps read-aloud and the display switch behind the more button', () => {
    const { api, actions, q } = mount();
    api.update({ ...idle, status: 'done', translated: 5 });
    expect(q<HTMLElement>('.menu').hidden).toBe(true);
    q<HTMLButtonElement>('.more').click();
    expect(q<HTMLElement>('.menu').hidden).toBe(false);

    const [read, mode] = q<HTMLElement>('.menu').querySelectorAll<HTMLButtonElement>('.pill');
    expect(read!.textContent).toBe(zh('tts.read'));
    // The pill names the mode a tap switches to.
    expect(mode!.textContent).toBe(zh('display.translation'));
    read!.click();
    expect(actions.toggleRead).toHaveBeenCalledTimes(1);
    expect(q<HTMLElement>('.menu').hidden).toBe(true);

    q<HTMLButtonElement>('.more').click();
    mode!.click();
    expect(actions.toggleMode).toHaveBeenCalledTimes(1);
  });

  it('shows stop while reading and the other mode name once switched', () => {
    const { api, q } = mount();
    api.update({ status: 'done', translated: 3, speaking: true, displayMode: 'translation' });
    const [read, mode] = q<HTMLElement>('.menu').querySelectorAll<HTMLButtonElement>('.pill');
    expect(read!.textContent).toBe(zh('tts.stop'));
    expect(mode!.textContent).toBe(zh('display.bilingual'));
  });

  it('does not offer reading before anything is translated', () => {
    const { q } = mount();
    const [read] = q<HTMLElement>('.menu').querySelectorAll<HTMLButtonElement>('.pill');
    expect(read!.hidden).toBe(true);
  });

  it('can be hidden for the page', () => {
    const { q } = mount();
    q<HTMLButtonElement>('.more').click();
    const hide = q<HTMLElement>('.menu').querySelectorAll<HTMLButtonElement>('.pill')[2]!;
    expect(hide.textContent).toBe(zh('float.hide'));
    hide.click();
    expect(document.getElementById('yilin-floating')).toBeNull();
  });

  it('starts where it was left, kept inside the screen', () => {
    expect(mount(0.3).q<HTMLElement>('.fab').style.top).toBe('30vh');
    document.querySelectorAll('#yilin-floating').forEach((n) => n.remove());
    expect(mount(5).q<HTMLElement>('.fab').style.top).toBe('82vh');
  });

  it('is removed on dispose', () => {
    const { api } = mount();
    api.dispose();
    expect(document.getElementById('yilin-floating')).toBeNull();
  });
});

describe('floating button setting', () => {
  it('defaults to auto and reads back only the known values', () => {
    expect(DEFAULT_SETTINGS.floatingButton).toBe('auto');
    expect(sanitizeSettings({ floatingButton: 'on' }).floatingButton).toBe('on');
    expect(sanitizeSettings({ floatingButton: 'off' }).floatingButton).toBe('off');
    expect(sanitizeSettings({ floatingButton: 'sometimes' }).floatingButton).toBe('auto');
  });
});
