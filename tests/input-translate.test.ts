// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInputTranslate } from '../src/content/input-translate';
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/settings';

const settings = (patch: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...patch });
const press = (el: Element, key: string, init: KeyboardEventInit = {}) =>
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('translating typed text', () => {
  let box: HTMLTextAreaElement;
  const made: { dispose(): void }[] = [];
  // Each instance listens on the document; the next test must not hear the last one.
  afterEach(() => made.splice(0).forEach((m) => m.dispose()));
  beforeEach(() => {
    document.body.innerHTML = '<textarea></textarea>';
    box = document.querySelector('textarea')!;
    box.focus();
    // jsdom has no execCommand; the fallback path sets the value itself.
    (document as unknown as { execCommand: () => boolean }).execCommand = () => false;
  });
  const make = (patch: Partial<Settings>, reply = 'hello') => {
    const translate = vi.fn(async () => [{ id: 'input', ok: true as const, text: reply }]);
    const api = createInputTranslate(document, { settings: settings(patch), translate });
    made.push(api);
    return { translate, api };
  };

  it('replaces the whole box on the third space, without the spaces', async () => {
    const { translate } = make({ inputTranslate: 'spaces' });
    box.value = '你好';
    press(box, ' ');
    press(box, ' ');
    expect(press(box, ' ')).toBe(false); // the third is swallowed
    await settle();
    expect(translate).toHaveBeenCalledWith([{ id: 'input', text: '你好' }], 'en');
    expect(box.value).toBe('hello');
  });

  it('does nothing when switched off, and three spaces are not counted across other keys', async () => {
    const off = make({ inputTranslate: 'off' });
    box.value = '你好';
    press(box, ' ');
    press(box, ' ');
    expect(press(box, ' ')).toBe(true);
    off.api.dispose();
    const { translate } = make({ inputTranslate: 'spaces' });
    press(box, ' ');
    press(box, 'a');
    press(box, ' ');
    press(box, ' ');
    await settle();
    expect(translate).not.toHaveBeenCalled();
  });

  it('Alt+Enter translates only the selection when there is one', async () => {
    const { translate } = make({ inputTranslate: 'key' }, 'good');
    box.value = '你好 世界';
    box.setSelectionRange(0, 2);
    press(box, 'Enter', { altKey: true });
    await settle();
    expect(translate).toHaveBeenCalledWith([{ id: 'input', text: '你好' }], 'en');
  });

  it('leaves password boxes alone', async () => {
    document.body.innerHTML = '<input type="password">';
    const input = document.querySelector('input')!;
    input.focus();
    const { translate } = make({ inputTranslate: 'both' });
    press(input, 'Enter', { altKey: true });
    await settle();
    expect(translate).not.toHaveBeenCalled();
  });

  it('keeps the original when the translation fails', async () => {
    const translate = vi.fn(async () => [{ id: 'input', ok: false as const, error: 'NETWORK' as const }]);
    made.push(createInputTranslate(document, { settings: settings({ inputTranslate: 'key' }), translate }));
    box.value = '你好';
    press(box, 'Enter', { altKey: true });
    await settle();
    expect(box.value).toBe('你好');
  });
});
