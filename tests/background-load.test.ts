// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

const event = () => ({ addListener: vi.fn() });

/** Like `event()`, but keeps every registered listener so a test can dispatch a message to them,
 * the way `chrome.runtime.onMessage` really does: each handler self-filters on `message.type`. */
function messageEvent() {
  const listeners: ((message: unknown, sender: unknown, sendResponse: (r: unknown) => void) => unknown)[] = [];
  return {
    addListener: (fn: typeof listeners[number]) => listeners.push(fn),
    async dispatch(message: unknown, sender: unknown) {
      for (const listener of listeners) {
        let resolved: unknown;
        const settled = new Promise((resolve) => {
          const keepsChannelOpen = listener(message, sender, (r) => resolve(r));
          if (keepsChannelOpen !== true) resolve(undefined);
        });
        resolved = await settled;
        if (resolved !== undefined) return resolved;
      }
      return undefined;
    },
  };
}

/** The browser APIs the background script touches while it loads. */
function stubBrowser(extra: Record<string, unknown>) {
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'x',
      onMessage: extra['onMessage'] ?? event(),
      onInstalled: event(),
      onStartup: event(),
      getURL: (p: string) => p,
      openOptionsPage: vi.fn(),
    },
    storage: { onChanged: event(), local: { get: vi.fn(async () => ({})), set: vi.fn() } },
    permissions: { onAdded: event(), onRemoved: event(), contains: vi.fn(async () => false), remove: vi.fn(async () => true) },
    tabs: { create: vi.fn() },
    // The registration sync runs unconditionally at module load (not only from onInstalled/
    // onStartup, see below), so every test touches these even when nothing ends up registered.
    scripting: { getRegisteredContentScripts: vi.fn(async () => []), registerContentScripts: vi.fn(async () => {}), unregisterContentScripts: vi.fn(async () => {}), updateContentScripts: vi.fn(async () => {}) },
    ...extra,
  });
}

describe('background script start-up', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('loads in Firefox for Android, which has no context menus and no keyboard commands', async () => {
    stubBrowser({});
    await expect(import('../src/background/index')).resolves.toBeDefined();
  });

  it('registers the menu click and the shortcut where they exist', async () => {
    const contextMenus = { create: vi.fn(), update: vi.fn(), onClicked: event() };
    const commands = { onCommand: event() };
    stubBrowser({ contextMenus, commands });
    await import('../src/background/index');
    expect(contextMenus.onClicked.addListener).toHaveBeenCalledTimes(1);
    expect(commands.onCommand.addListener).toHaveBeenCalledTimes(1);
  });

  it('(re)applies the "run everywhere" content script registration on every load, not only onInstalled/onStartup', async () => {
    // onInstalled and onStartup miss the far more common case on Android: this script itself
    // being killed and respawned by the OS, with neither event firing again. Without a call made
    // unconditionally at load, that respawn drops the registration and the floating button stops
    // appearing on new or back-navigated pages until something else happens to re-run it
    // (doc/14 §10.4) — so this has to happen just from importing the module, no event required.
    const scripting = {
      getRegisteredContentScripts: vi.fn(async () => []),
      registerContentScripts: vi.fn(async () => {}),
      unregisterContentScripts: vi.fn(async () => {}),
      updateContentScripts: vi.fn(async () => {}),
    };
    const permissions = { onAdded: event(), onRemoved: event(), contains: vi.fn(async () => true) }; // "run on all sites" granted
    stubBrowser({ scripting, permissions });
    await import('../src/background/index');
    await vi.waitFor(() => expect(scripting.registerContentScripts).toHaveBeenCalledTimes(1));
    expect(scripting.registerContentScripts).toHaveBeenCalledWith([expect.objectContaining({ matches: ['*://*/*'] })]);
  });
});

describe('the floating button\'s "auto-translate this site" switch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  const sender = { id: 'x', tab: { id: 1 } };

  it('turns on directly, no redirect, when "run on all sites" already covers the host', async () => {
    // Reported as a bad experience: the reader had already granted all-sites access, so asking
    // them to click through the options page again for one specific host was pure friction —
    // that access already covers it, nothing new needs requesting.
    const storage = { onChanged: event(), local: { get: vi.fn(async () => ({})), set: vi.fn() } };
    const permissions = { onAdded: event(), onRemoved: event(), contains: vi.fn(async () => true), remove: vi.fn() };
    const tabs = { create: vi.fn() };
    const onMessage = messageEvent();
    stubBrowser({ onMessage, storage, permissions, tabs });
    await import('../src/background/index');

    const result = await onMessage.dispatch({ type: 'SET_AUTO_SITE', host: 'example.com', on: true }, sender);
    expect(result).toEqual({ ok: true });
    expect(storage.local.set).toHaveBeenCalledWith(expect.objectContaining({ autoTranslateSites: ['example.com'] }));
    expect(tabs.create).not.toHaveBeenCalled();
  });

  it('refuses to turn on without that permission, so the content script can fall back to opening the options page', async () => {
    const storage = { onChanged: event(), local: { get: vi.fn(async () => ({})), set: vi.fn() } };
    const permissions = { onAdded: event(), onRemoved: event(), contains: vi.fn(async () => false), remove: vi.fn() };
    const tabs = { create: vi.fn() };
    const onMessage = messageEvent();
    stubBrowser({ onMessage, storage, permissions, tabs });
    await import('../src/background/index');

    const result = await onMessage.dispatch({ type: 'SET_AUTO_SITE', host: 'example.com', on: true }, sender);
    expect(result).toMatchObject({ ok: false });
    // The module's own unconditional content-script sync (background-load.test.ts above) also
    // touches storage on load, migrating a settings version — unrelated to this switch, so this
    // checks specifically that the site was never added rather than that storage was untouched.
    expect(storage.local.set).not.toHaveBeenCalledWith(expect.objectContaining({ autoTranslateSites: expect.anything() }));

    // The content script's own fallback, exercised the same way it really arrives.
    await onMessage.dispatch({ type: 'OPEN_AUTO_SITE', host: 'example.com' }, sender);
    expect(tabs.create).toHaveBeenCalledWith(expect.objectContaining({ url: expect.stringContaining('autoHost=example.com') }));
  });

  it('turns off without needing the permission check, and hands the permission back', async () => {
    const storage = { onChanged: event(), local: { get: vi.fn(async () => ({ autoTranslateSites: ['example.com'] })), set: vi.fn() } };
    const permissions = { onAdded: event(), onRemoved: event(), contains: vi.fn(async () => false), remove: vi.fn(async () => true) };
    const onMessage = messageEvent();
    stubBrowser({ onMessage, storage, permissions });
    await import('../src/background/index');

    const result = await onMessage.dispatch({ type: 'SET_AUTO_SITE', host: 'example.com', on: false }, sender);
    expect(result).toEqual({ ok: true });
    expect(storage.local.set).toHaveBeenCalledWith(expect.objectContaining({ autoTranslateSites: [] }));
    expect(permissions.remove).toHaveBeenCalledTimes(1);
  });
});
