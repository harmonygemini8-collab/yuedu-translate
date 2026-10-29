import type { Translator } from './i18n';
import { isEngine, type Engine, type TranslateEngine } from './messages';
import { ENGINE_OPTIONS, ENGINE_TIERS, TARGET_LANGUAGES, engineSupports, type EngineChoice, type TargetLang } from './settings';

declare const __YILIN_API_BASE__: string;
declare const __YILIN_PUBLIC__: boolean;

/** Backend origin baked in at build time (YILIN_API_BASE); empty means only browser-side engines are available. */
export const API_BASE: string = typeof __YILIN_API_BASE__ === 'string' ? __YILIN_API_BASE__ : '';

/** Public (store) build: no development controls, and services that cannot work are hidden rather than greyed out. */
export const IS_PUBLIC: boolean = typeof __YILIN_PUBLIC__ === 'boolean' ? __YILIN_PUBLIC__ : false;

/** Google OAuth client ID baked in at build time; empty string when not configured. */

/** The development access token is kept apart from Settings so page-facing code never handles it. */
export const API_TOKEN_KEY = 'apiToken';

export const hasBackend = () => API_BASE !== '';

/** Engines that go through the Yuedu backend (and therefore need a backend in this build). */
export const needsBackend = (choice: EngineChoice): choice is TranslateEngine => isEngine(choice);

/** The engine actually used: backend engines fall back to free Google in builds without a backend. */
export const effectiveEngine = (choice: EngineChoice): EngineChoice =>
  needsBackend(choice) && !hasBackend() ? 'google-free' : choice;

/** Account session token (doc/15 §5.2); like the dev token it stays out of Settings and away from content scripts. */
export const SESSION_TOKEN_KEY = 'sessionToken';

const readString = async (key: string) => {
  const value = (await chrome.storage.local.get(key))[key];
  return typeof value === 'string' ? value.trim().slice(0, 256) : '';
};

/** The key of the reader's own service: kept apart from Settings and used only by the background script. */
export const CUSTOM_KEY_KEY = 'customKey';
export const loadCustomKey = () => readString(CUSTOM_KEY_KEY);

export const loadApiToken = () => readString(API_TOKEN_KEY);
export const loadSessionToken = () => readString(SESSION_TOKEN_KEY);

/** Token for backend calls: the signed-in account, or the development token in non-public builds. */
export async function loadAuthToken(): Promise<string> {
  return (await loadSessionToken()) || (IS_PUBLIC ? '' : await loadApiToken());
}

export interface Account {
  user: { id: string; email: string };
  plan: { id: 'free' | 'pro_monthly' | 'pro_yearly'; status: string; periodEnd: string | null };
  quotas: Partial<Record<'free_daily' | 'pro_standard' | 'pro_premium', { used: number; limit: number; resetAt: string }>>;
  engines: Partial<Record<Engine, boolean>>;
}

type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string };

async function call<T>(method: string, path: string, options: { body?: unknown; token?: string } = {}): Promise<ApiResult<T>> {
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}) },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 204) return { ok: true, data: undefined as T };
    const body = (await response.json()) as { ok?: boolean; error?: string };
    return response.ok && body.ok ? { ok: true, data: body as T } : { ok: false, error: body.error ?? `HTTP ${response.status}` };
  } catch {
    return { ok: false, error: 'NETWORK' };
  }
}

export const requestLoginCode = (email: string, uiLang: string) => call<void>('POST', '/v1/auth/email/start', { body: { email, uiLang } });

/** Signs in and stores the session token. */
export async function signIn(email: string, code: string, uiLang: string): Promise<ApiResult<{ user: Account['user'] }>> {
  const result = await call<{ token: string; user: Account['user'] }>('POST', '/v1/auth/email/verify', {
    body: { email, code, uiLang, deviceName: navigator.userAgent.includes('Edg/') ? 'Edge' : 'Chrome' },
  });
  if (result.ok) await chrome.storage.local.set({ [SESSION_TOKEN_KEY]: result.data.token });
  return result;
}

/** Signs out locally even when the server cannot be reached. */
export async function signOut(): Promise<void> {
  const token = await loadSessionToken();
  await chrome.storage.local.remove(SESSION_TOKEN_KEY);
  if (token) await call<void>('POST', '/v1/auth/logout', { token });
}

/** Current account, or null when signed out; an expired session is cleared. */
export async function fetchAccount(): Promise<ApiResult<Account | null>> {
  const token = await loadSessionToken();
  if (!token || !hasBackend()) return { ok: true, data: null };
  const result = await call<Account>('GET', '/v1/me', { token });
  if (!result.ok && result.error === 'UNAUTHENTICATED') {
    await chrome.storage.local.remove(SESSION_TOKEN_KEY);
    return { ok: true, data: null };
  }
  return result;
}

export async function deleteAccount(): Promise<ApiResult<void>> {
  const result = await call<void>('DELETE', '/v1/me', { token: await loadSessionToken() });
  if (result.ok) await chrome.storage.local.remove(SESSION_TOKEN_KEY);
  return result;
}

/** VIP engines need a Pro plan; the other backend engines need any account. */
export const isVipEngine = (choice: EngineChoice) => ENGINE_TIERS[choice] === 'paid';

export interface ServerStatus {
  engines: Record<Engine, boolean>;
  usage: {
    month: string;
    costUsd: number;
    budgetUsd: number;
    chars: Partial<Record<Engine, number>>;
    charLimits: Partial<Record<Engine, number>>;
  };
}

/**
 * Which heading an engine sits under. The free tier splits in two because the difference decides
 * whether the reader can use it at all: free Google runs in the browser and needs nothing, while
 * every other free engine goes through our server, which meters a per-user daily quota and so
 * needs an account. Showing them all as plain "free" promised something four of the five could
 * not deliver until the reader signed in.
 */
const groupOf = (value: EngineChoice) =>
  value === 'custom' ? 'own' : ENGINE_TIERS[value] === 'paid' ? 'paid' : needsBackend(value) ? 'freeAccount' : 'free';

/** Fill a <select> with engines grouped by tier, labelled in the UI language. */
export function fillEngineSelect(select: HTMLSelectElement, t: Translator): void {
  select.replaceChildren();
  const groups = new Map<string, HTMLOptGroupElement>();
  for (const value of Object.keys(ENGINE_OPTIONS) as EngineChoice[]) {
    if (IS_PUBLIC && needsBackend(value) && !hasBackend()) continue;
    const key = groupOf(value);
    let group = groups.get(key);
    if (!group) {
      group = document.createElement('optgroup');
      group.label = t(`tier.${key}`);
      groups.set(key, group);
      select.append(group);
    }
    group.append(new Option(t(`engine.${value}`), value));
  }
}

export function fillTargetSelect(select: HTMLSelectElement): void {
  select.replaceChildren(...Object.entries(TARGET_LANGUAGES).map(([value, label]) => new Option(label, value)));
}

/**
 * Disable combinations that cannot work: engines that need a backend in builds without one,
 * engines that cannot produce the chosen language, and languages the chosen engine lacks.
 */
export function syncAvailability(engineSelect: HTMLSelectElement, targetSelect: HTMLSelectElement): void {
  const engine = engineSelect.value as EngineChoice;
  const lang = targetSelect.value as TargetLang;
  for (const option of engineSelect.options) {
    const value = option.value as EngineChoice;
    option.disabled = (needsBackend(value) && !hasBackend()) || !engineSupports(value, lang);
  }
  for (const option of targetSelect.options) option.disabled = !engineSupports(engine, option.value as TargetLang);
}

export async function fetchServerStatus(token: string): Promise<{ ok: true; status: ServerStatus } | { ok: false; error: string }> {
  try {
    const response = await fetch(`${API_BASE}/v1/status`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await response.json()) as { ok?: boolean; error?: string } & Partial<ServerStatus>;
    return response.ok && body.engines && body.usage ? { ok: true, status: body as ServerStatus } : { ok: false, error: body.error ?? `HTTP ${response.status}` };
  } catch {
    return { ok: false, error: 'NETWORK' };
  }
}
