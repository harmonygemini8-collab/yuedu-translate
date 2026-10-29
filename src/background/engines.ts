/**
 * Running a batch on the engine the reader chose, and when it fails or answers in the wrong language, on the next
 * free one. Only free engines are ever fallen back to: a failure must never spend a VIP quota or reach a paid service
 * the reader did not pick.
 */

import type { SegmentInput, SegmentResult } from '../shared/messages';
import { looksTranslated } from '../shared/script';
import { ENGINE_TIERS, engineSupports, type EngineChoice, type TargetLang } from '../shared/settings';

/** The order free engines are tried in: the one that needs no account first. */
const FREE_ORDER: EngineChoice[] = ['google-free', 'microsoft', 'hunyuan-mt', 'qwen-free', 'glm-free'];
const MAX_ATTEMPTS = 3;

type ErrorCode = Extract<SegmentResult, { ok: false }>['error'];

export interface EngineDeps {
  run(engine: EngineChoice, segments: SegmentInput[], targetLang: TargetLang): Promise<SegmentResult[]>;
  /** Whether the reader is signed in; the server-side engines need it. */
  signedIn(): Promise<boolean>;
  errorCode(err: unknown): ErrorCode;
  /** Told which engine actually answered each segment, so the caller can cache under the real one, not the one it asked first. */
  onUsed?(id: string, engine: EngineChoice): void;
}

export async function fallbackChain(primary: EngineChoice, lang: TargetLang, signedIn: boolean): Promise<EngineChoice[]> {
  return FREE_ORDER.filter((e) => e !== primary && ENGINE_TIERS[e] === 'free' && engineSupports(e, lang) && (e === 'google-free' || signedIn));
}

export async function translateWithFallback(
  primary: EngineChoice,
  segments: SegmentInput[],
  targetLang: TargetLang,
  enabled: boolean,
  deps: EngineDeps,
): Promise<SegmentResult[]> {
  const chain = [primary, ...(enabled ? (await fallbackChain(primary, targetLang, await deps.signedIn())).slice(0, MAX_ATTEMPTS - 1) : [])];
  const accepted = new Map<string, SegmentResult>();
  /** What the first engine said about a segment that is still unsettled: the error, or an answer in the wrong language. */
  const first = new Map<string, SegmentResult>();
  let pending = segments;
  for (const engine of chain) {
    if (pending.length === 0) break;
    let answers: SegmentResult[];
    try {
      answers = await deps.run(engine, pending, targetLang);
    } catch (err) {
      answers = pending.map((s) => ({ id: s.id, ok: false as const, error: deps.errorCode(err) }));
    }
    const byId = new Map(answers.map((r) => [r.id, r]));
    for (const s of pending) {
      const r = byId.get(s.id) ?? { id: s.id, ok: false as const, error: 'PROVIDER_UNAVAILABLE' as const };
      if (r.ok && looksTranslated(s.text, r.text, targetLang)) {
        accepted.set(s.id, r);
        deps.onUsed?.(s.id, engine);
      }
      else if (!first.has(s.id)) first.set(s.id, r);
    }
    pending = segments.filter((s) => !accepted.has(s.id));
    // A request the service called invalid will be invalid for the next one too.
    if (pending.length > 0 && [...first.values()].every((r) => !r.ok && r.error === 'INVALID_REQUEST')) break;
  }
  return segments.map((s) => accepted.get(s.id) ?? first.get(s.id)!);
}
