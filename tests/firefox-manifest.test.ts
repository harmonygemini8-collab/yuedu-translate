import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIREFOX_ANDROID_MIN_VERSION, FIREFOX_MIN_VERSION, GECKO_ID, firefoxManifest } from '../scripts/manifest.mjs';

const chrome = JSON.parse(readFileSync(join(__dirname, '..', 'public', 'manifest.json'), 'utf8')) as Record<string, any>;

describe('Firefox manifest', () => {
  const firefox = firefoxManifest(chrome) as Record<string, any>;

  it('runs the background as a script, not a service worker', () => {
    expect(firefox.background).toEqual({ scripts: ['background.js'] });
    expect(chrome.background.service_worker).toBe('background.js');
  });

  it('leaves the Chrome manifest alone', () => {
    const before = JSON.stringify(chrome);
    firefoxManifest(chrome);
    expect(JSON.stringify(chrome)).toBe(before);
    expect(chrome.browser_specific_settings).toBeUndefined();
    expect(chrome.minimum_chrome_version).toBeDefined();
  });

  it('drops the Chrome-only version and keeps every permission the same', () => {
    expect(firefox.minimum_chrome_version).toBeUndefined();
    expect(firefox.permissions).toEqual(chrome.permissions);
    expect(firefox.optional_host_permissions).toEqual(chrome.optional_host_permissions);
    expect(firefox.host_permissions).toBeUndefined();
  });

  it('declares the gecko id, the minimum version and the data it sends out', () => {
    const gecko = firefox.browser_specific_settings.gecko;
    expect(gecko.id).toBe(GECKO_ID);
    expect(gecko.strict_min_version).toBe(FIREFOX_MIN_VERSION);
    expect(gecko.data_collection_permissions.required).toEqual(['websiteContent']);
    expect(gecko.data_collection_permissions.optional).toEqual(['authenticationInfo', 'personallyIdentifyingInfo']);
    expect(firefox.browser_specific_settings.gecko_android.strict_min_version).toBe(FIREFOX_ANDROID_MIN_VERSION);
  });
});
