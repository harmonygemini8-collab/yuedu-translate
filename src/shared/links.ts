/**
 * Public addresses shown in the extension UI. Keep them in sync with
 * `website/src/config.ts` and the store listing in `release/store/listing.md`.
 */

/** Promotional website (see doc/13 §4 for the domain). */
export const HOMEPAGE_URL = 'https://getyuedu.com/';

/** Privacy policy page on the website; the same text also lives in the options page. */
export const PRIVACY_URL = 'https://getyuedu.com/privacy.html';

/** Address for support and privacy questions, identical to the website's CONTACT_EMAIL. */
export const SUPPORT_EMAIL = 'support@getyuedu.com';

/** Version from the manifest; falls back to an empty string outside the extension (tests, demo page). */
export const extensionVersion = (): string => globalThis.chrome?.runtime?.getManifest?.().version ?? '';

declare const __YILIN_BUILD__: string;
/** Which build this is: the commit and the time it was made. */
export const buildStamp = (): string => (typeof __YILIN_BUILD__ === 'string' ? __YILIN_BUILD__ : 'dev');
