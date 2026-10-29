// The Firefox variant of the extension manifest. Everything else in the package is the same code as the Chrome one;
// only the manifest differs, because Firefox runs a background script where Chrome runs a service worker, and
// asks add-ons to declare their gecko id and the kinds of data they send out.

export const GECKO_ID = 'yuedu-translate@warptech.cc';
/** The first Firefox that understands `data_collection_permissions` (older ones ignore it or, before 128, reject it). */
export const FIREFOX_MIN_VERSION = '140.0';
export const FIREFOX_ANDROID_MIN_VERSION = '142.0';

/** Returns a new manifest for Firefox; the one given (the Chrome one) is not touched. */
export function firefoxManifest(manifest) {
  const { minimum_chrome_version: _chromeOnly, background, ...rest } = manifest;
  const entry = background?.service_worker ?? 'background.js';
  return {
    ...rest,
    background: { scripts: [entry] },
    browser_specific_settings: {
      gecko: {
        id: GECKO_ID,
        strict_min_version: FIREFOX_MIN_VERSION,
        // What leaves the browser, in Firefox's vocabulary (doc/07 §1): the page text to translate is what the
        // add-on is for; the email and the sign-in token exist only if the reader chooses to sign in.
        data_collection_permissions: {
          required: ['websiteContent'],
          optional: ['authenticationInfo', 'personallyIdentifyingInfo'],
        },
      },
      gecko_android: { strict_min_version: FIREFOX_ANDROID_MIN_VERSION },
    },
  };
}
