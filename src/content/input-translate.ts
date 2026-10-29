/**
 * Translating what the reader types, in place. After typing in a text box, three spaces or Alt+Enter replace
 * the text with its translation; Ctrl+Z brings the original back, because the replacement is made the way
 * typing is. Nothing is read until the trigger: text is never sent as it is typed.
 */

import { createTranslator, resolveUiLang } from '../shared/i18n';
import type { SegmentInput, SegmentResult } from '../shared/messages';
import { isSiteDisabled, type Settings, type TargetLang } from '../shared/settings';

export interface InputTranslateDeps {
  settings: Settings;
  translate(segments: SegmentInput[], targetLang: TargetLang): Promise<SegmentResult[]>;
}

type TextBox = HTMLInputElement | HTMLTextAreaElement | HTMLElement;

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', '']);
const NOTE_ID = 'yilin-input-note';
const NOTE_MS = 2500;

/** The box the reader is typing in; passwords, numbers and everything that is not free text are left alone. */
export function typingTarget(doc: Document): TextBox | null {
  const el = doc.activeElement;
  if (!(el instanceof HTMLElement)) return null;
  if (el instanceof HTMLTextAreaElement) return el.readOnly || el.disabled ? null : el;
  if (el instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(el.type) && !el.readOnly && !el.disabled ? el : null;
  return el.isContentEditable ? el : null;
}

const isField = (el: TextBox): el is HTMLInputElement | HTMLTextAreaElement => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;

function readText(el: TextBox, selectionOnly: boolean): { text: string; selected: boolean } {
  if (isField(el)) {
    const { selectionStart: a, selectionEnd: b, value } = el;
    if (selectionOnly && a !== null && b !== null && a !== b) return { text: value.slice(a, b), selected: true };
    return { text: value, selected: false };
  }
  const selection = el.ownerDocument.getSelection();
  if (selectionOnly && selection && !selection.isCollapsed && el.contains(selection.anchorNode) && el.contains(selection.focusNode)) {
    return { text: selection.toString(), selected: true };
  }
  return { text: el.innerText, selected: false };
}

/** Selects what is to be replaced: the part that was read. */
function selectTarget(el: TextBox, selected: boolean): void {
  if (isField(el)) {
    if (!selected) el.select();
    return;
  }
  if (selected) return;
  const selection = el.ownerDocument.getSelection();
  const range = el.ownerDocument.createRange();
  range.selectNodeContents(el);
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/** Typing, as far as the page can tell: its framework sees an input event, and undo has a step to go back to. */
function replaceSelection(el: TextBox, text: string): void {
  const doc = el.ownerDocument;
  if (doc.execCommand('insertText', false, text)) return;
  if (isField(el)) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, text);
  } else {
    el.textContent = text;
  }
  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
}

export function createInputTranslate(doc: Document, deps: InputTranslateDeps) {
  let settings = deps.settings;
  let spaces = 0;
  let busy = false;
  let noteTimer: ReturnType<typeof setTimeout> | undefined;

  const t = () => createTranslator(resolveUiLang(settings.uiLang));
  const wantsSpaces = () => settings.inputTranslate === 'spaces' || settings.inputTranslate === 'both';
  const wantsKey = () => settings.inputTranslate === 'key' || settings.inputTranslate === 'both';

  /** A small line above the box: working, or what went wrong. */
  function note(el: TextBox, text: string, keep = false) {
    doc.getElementById(NOTE_ID)?.remove();
    clearTimeout(noteTimer);
    const rect = el.getBoundingClientRect();
    const box = doc.createElement('div');
    box.id = NOTE_ID;
    box.setAttribute('data-yilin', 'input-note');
    box.textContent = text;
    Object.assign(box.style, {
      position: 'fixed', left: `${Math.max(8, rect.left)}px`, top: `${Math.max(8, rect.top - 30)}px`, zIndex: '2147483000',
      padding: '3px 10px', borderRadius: '6px', font: '13px/1.4 system-ui, sans-serif', color: '#fff',
      background: '#1f8a70', pointerEvents: 'none', boxShadow: '0 2px 8px rgba(0,0,0,.25)',
    });
    doc.documentElement.append(box);
    if (!keep) noteTimer = setTimeout(() => box.remove(), NOTE_MS);
  }

  async function run(el: TextBox, selectionOnly: boolean) {
    if (busy) return;
    const read = readText(el, selectionOnly);
    const source = read.selected ? read.text : read.text.replace(/\s+$/, '');
    if (!source.trim()) return;
    busy = true;
    note(el, t()('input.working'), true);
    try {
      const [result] = await deps.translate([{ id: 'input', text: source }], settings.inputLang);
      if (!result?.ok) throw new Error('translate failed');
      // The reader kept typing or left the box while it was being translated: that answer is for old text.
      if (doc.activeElement !== el || readText(el, selectionOnly).text !== read.text) throw new Error('changed');
      selectTarget(el, read.selected);
      replaceSelection(el, result.text);
      doc.getElementById(NOTE_ID)?.remove();
    } catch {
      note(el, t()('input.failed'));
    } finally {
      busy = false;
    }
  }

  const onKeydown = (event: KeyboardEvent) => {
    if (settings.inputTranslate === 'off' || isSiteDisabled(settings, doc.location?.hostname ?? '') || event.isComposing || event.keyCode === 229) return;
    const el = typingTarget(doc);
    if (event.key === 'Enter' && event.altKey && wantsKey()) {
      if (!el) return;
      event.preventDefault();
      event.stopPropagation();
      void run(el, true);
      return;
    }
    if (event.key !== ' ' || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
      spaces = 0;
      return;
    }
    if (!wantsSpaces() || !el) return;
    spaces++;
    if (spaces < 3) return;
    spaces = 0;
    event.preventDefault();
    event.stopPropagation();
    void run(el, false);
  };
  const reset = () => {
    spaces = 0;
  };
  doc.addEventListener('keydown', onKeydown, true);
  doc.addEventListener('focusin', reset, true);

  return {
    updateSettings(next: Settings) {
      settings = next;
      spaces = 0;
    },
    dispose() {
      doc.removeEventListener('keydown', onKeydown, true);
      doc.removeEventListener('focusin', reset, true);
      doc.getElementById(NOTE_ID)?.remove();
      clearTimeout(noteTimer);
    },
  };
}
