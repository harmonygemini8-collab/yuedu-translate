# Project rules (public repo)

- Brand: 阅渡 · 双语对照翻译 (Traditional Chinese: 閱渡 · 雙語對照翻譯); English display name: Yuedu Translate. Keep legacy `YILIN_*`/`yilin-*` identifiers for compatibility.
- All user-facing text goes through `src/shared/i18n.ts` (zh-CN is the source; add every key to all seven catalogs: zh-CN, zh-TW, en, vi, ms, ar, ja). Extension name/description live in `public/_locales`.
- No remote code, minimal permissions; translations are rendered with `textContent` only.
- Verify with `npm run check` (typecheck + vitest + esbuild build).
- Extraction changes: run `npm run eval:extraction`; add an annotated fixture in `tests/fixtures/pages/` before changing rules, and log results in `tests/fixtures/README.md`.
- Engines here are limited to the client-side ones: the free Google endpoint (`src/background/google-free.ts`) and the "own key" OpenAI-compatible client (`src/background/custom-engine.ts`). Server-backed engines (Microsoft, paid Google, OpenAI via a hosted key) live in the closed-source server repository and are out of scope here.
- Product docs live in `doc/` (Chinese); keep them in sync with code changes in the same change. Requirement IDs (FR-xx) link docs, code and tests. A few operational docs (website, release/store ops, paid plan, server deployment, admin console, invite ops, company/payment, promotion) stay in the private repo and are not duplicated here.
- Pin dependency versions exactly and prefer releases older than 7 days.
- No CLA yet — external PRs are reviewed but not merged until one exists (see `doc/25-plan-progress-and-open-core.md`).
