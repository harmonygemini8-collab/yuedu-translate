// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFloatingButton, type FloatingActions, type FloatingState } from '../src/content/floating';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../src/shared/settings';
import { createTranslator } from '../src/shared/i18n';

const zh = createTranslator('zh-CN');
const settings = { ...DEFAULT_SETTINGS, uiLang: 'zh-CN' as const };
const idle: FloatingState = { status: 'idle', translated: 0, speaking: false, displayMode: 'bilingual', autoTranslateHere: false };

function mount(top?: number | null) {
  const actions: FloatingActions = {
    toggle: vi.fn(),
    toggleRead: vi.fn(),
    toggleMode: vi.fn(),
    toggleSelectionLookup: vi.fn(),
    toggleAutoTranslateSite: vi.fn(),
  };
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

  it('shows the brand mark, not a translate/restore icon that swaps', () => {
    // The icon no longer says what a tap will do (doc/04 §4.3 redesign): it is always the logo,
    // and the aria-label carries the meaning instead, for anyone listening rather than looking.
    const { q } = mount();
    expect(q<HTMLButtonElement>('.ball').querySelector('svg')).not.toBeNull();
    expect(q<HTMLButtonElement>('.ball').getAttribute('aria-label')).toBe(zh('action.translate'));
  });

  it('translates on a tap when nothing is translated, and says so', () => {
    const { actions, q } = mount();
    q<HTMLButtonElement>('.ball').click();
    expect(actions.toggle).toHaveBeenCalledTimes(1);
  });

  it('offers to show the original once there is a translation', () => {
    const { api, q } = mount();
    api.update({ ...idle, status: 'done', translated: 5 });
    expect(q<HTMLButtonElement>('.ball').getAttribute('aria-label')).toBe(zh('action.restore'));
    expect(q('.fab').getAttribute('data-status')).toBe('done');
  });

  it('marks the logo as translated with a small badge instead of swapping its icon', () => {
    // The icon is always the brand mark now, so something else has to say "there is a translation
    // to look at" — a checkmark badge, shown once there is one and hidden again once there is not.
    const { api, q } = mount();
    expect(q('.fab').getAttribute('data-translated')).toBe('false');
    api.update({ ...idle, status: 'done', translated: 5 });
    expect(q('.fab').getAttribute('data-translated')).toBe('true');
    api.update({ ...idle, status: 'idle', translated: 0 });
    expect(q('.fab').getAttribute('data-translated')).toBe('false');
  });

  it('lets go of focus after a tap, so the gear it reveals does not get stuck showing', () => {
    // Clicking the logo used to leave it focused; :focus-within then kept the gear's hover
    // reveal true until something else on the page was clicked, well after the mouse had moved
    // away — reported as "the gear is still there after I translate and move the mouse off".
    const { q } = mount();
    const ball = q<HTMLButtonElement>('.ball');
    const blurred = vi.spyOn(ball, 'blur');
    ball.click();
    expect(blurred).toHaveBeenCalledTimes(1);
  });

  it('keeps the settings/read-aloud pill hidden until hovered or opened, but always visible on a touch screen', () => {
    const { q } = mount();
    // The gear and the read-aloud shortcut share one pill (not two separate circles), so there is
    // exactly one thing to reveal on hover, not one each.
    expect(q('.tools').children).toHaveLength(2);
    expect(q('.tools').querySelector('.gear')).not.toBeNull();
    expect(q('.tools').querySelector('.quick-read')).not.toBeNull();
    const css = q<HTMLStyleElement>('style').textContent!;
    expect(css).toMatch(/\.tools\s*{[^}]*opacity:\s*0;/);
    expect(css).toMatch(/\.fab\[data-coarse="true"\]\s*\.tools/);
    // jsdom answers matchMedia as not matching, i.e. a mouse, not a touch screen.
    expect(q<HTMLElement>('.fab').dataset['coarse']).toBe('false');
  });

  it('opens a panel with read-aloud, the display switch and selection lookup behind the gear', () => {
    const { api, actions, q } = mount();
    api.update({ ...idle, status: 'done', translated: 5 });
    expect(q<HTMLElement>('.panel').hidden).toBe(true);
    q<HTMLButtonElement>('.gear').click();
    expect(q<HTMLElement>('.panel').hidden).toBe(false);

    const [read, mode, lookup, autoSite, hide] = q<HTMLElement>('.panel').querySelectorAll<HTMLButtonElement>('.row');
    expect(read!.textContent).toBe(zh('tts.read'));
    expect(mode!.textContent).toBe(zh('display.translation'));
    expect(lookup!.textContent).toBe(zh('section.selection'));
    expect(autoSite!.textContent).toBe(zh('float.autoSite'));
    expect(hide!.textContent).toBe(zh('float.hide'));

    read!.click();
    expect(actions.toggleRead).toHaveBeenCalledTimes(1);
    // A switch stays open after being flipped, so several can be changed in one visit — unlike
    // the old one-shot pills, which each closed the menu as soon as one was picked.
    expect(q<HTMLElement>('.panel').hidden).toBe(false);

    mode!.click();
    expect(actions.toggleMode).toHaveBeenCalledTimes(1);

    lookup!.click();
    expect(actions.toggleSelectionLookup).toHaveBeenCalledTimes(1);

    autoSite!.click();
    expect(actions.toggleAutoTranslateSite).toHaveBeenCalledTimes(1);
  });

  it('shows the read-aloud, selection-lookup and auto-site rows as switches reflecting the current state', () => {
    const { api, q } = mount();
    api.update({ status: 'done', translated: 3, speaking: true, displayMode: 'translation', autoTranslateHere: true });
    q<HTMLButtonElement>('.gear').click();
    const [read, mode, lookup, autoSite] = q<HTMLElement>('.panel').querySelectorAll<HTMLButtonElement>('.row');
    expect(read!.getAttribute('aria-checked')).toBe('true');
    expect(mode!.getAttribute('aria-checked')).toBe('true');
    // The default settings start with selection lookup on.
    expect(lookup!.getAttribute('aria-checked')).toBe(String(settings.selectionLookup));
    expect(autoSite!.getAttribute('aria-checked')).toBe('true');
  });

  it('does not offer reading before anything is translated', () => {
    const { q } = mount();
    q<HTMLButtonElement>('.gear').click();
    const [read] = q<HTMLElement>('.panel').querySelectorAll<HTMLButtonElement>('.row');
    expect(read!.hidden).toBe(true);
    // Same reasoning for the shortcut under the gear: nothing to read yet, so it stays out of the way.
    expect(q<HTMLButtonElement>('.quick-read').hidden).toBe(true);
  });

  it('reads aloud straight from the shortcut under the gear, without opening the panel', () => {
    const { api, actions, q } = mount();
    api.update({ ...idle, status: 'done', translated: 4 });
    const quickRead = q<HTMLButtonElement>('.quick-read');
    expect(quickRead.hidden).toBe(false);
    expect(quickRead.getAttribute('aria-label')).toBe(zh('tts.read'));
    quickRead.click();
    expect(actions.toggleRead).toHaveBeenCalledTimes(1);
    expect(q<HTMLElement>('.panel').hidden).toBe(true);

    api.update({ ...idle, status: 'done', translated: 4, speaking: true });
    expect(quickRead.getAttribute('aria-label')).toBe(zh('tts.stop'));
    expect(quickRead.dataset['speaking']).toBe('true');
  });

  it('can be hidden for the page', () => {
    const { q } = mount();
    q<HTMLButtonElement>('.gear').click();
    const rows = q<HTMLElement>('.panel').querySelectorAll<HTMLButtonElement>('.row');
    const hide = rows[rows.length - 1]!;
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
