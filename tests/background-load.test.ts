// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

const event = () => ({ addListener: vi.fn() });

/** The browser APIs the background script touches while it loads. */
function stubBrowser(extra: Record<string, unknown>) {
  vi.stubGlobal('chrome', {
    runtime: { id: 'x', onMessage: event(), onInstalled: event(), onStartup: event(), getURL: (p: string) => p, openOptionsPage: vi.fn() },
    storage: { onChanged: event(), local: { get: vi.fn(async () => ({})), set: vi.fn() } },
    permissions: { onAdded: event(), onRemoved: event(), contains: vi.fn(async () => false) },
    // The registration sync runs unconditionally at module load (not only from onInstalled/
    // onStartup, see below), so every test touches these even when nothing ends up registered.
    scripting: { getRegisteredContentScripts: vi.fn(async () => []), registerContentScripts: vi.fn(async () => {}), unregisterContentScripts: vi.fn(async () => {}), updateContentScripts: vi.fn(async () => {}) },
    tabs: {},
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
