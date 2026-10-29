# 阅渡 · 双语对照翻译 (Yuedu Translate)

Bilingual web-reading Chrome/Firefox extension — the original stays in view,
the translation sits right under each paragraph.

**Install the official build:** [Chrome Web Store](https://chromewebstore.google.com/detail/kkljbeemilljlhcaegenbfldkkgemobe) · [getyuedu.com](https://getyuedu.com/)
(Firefox/AMO listing: coming soon.) This repository is the extension's open
source — not an installable package; most people should install from the
store link above instead of building from source.

This is the **public, open-core** part of the project: the extraction,
rendering, formula/term protection and translation-pipeline code under
AGPL-3.0 (see [LICENSE](LICENSE)). It builds a fully working extension on
its own, using the free Google translation engine with no account and no
server required.

Accounts, sync, paid quotas, the promotional website and the store listing
assets are developed in a separate, closed-source repository and are not
part of this one. The "own key" (OpenAI-compatible endpoint) feature here
sends text directly from the browser to the endpoint you configure — never
through any Yuedu server.

The project name "阅渡 / Yuedu Translate" and its icons are trademarks, not
covered by the code license — see [TRADEMARK.md](TRADEMARK.md).

## Quick start

```bash
npm install
npm run build:ext   # free Google engine only, no server needed, outputs to dist/
npm run preview     # local demo page at http://127.0.0.1:4173
```

Chrome: open `chrome://extensions` → enable Developer mode → "Load unpacked" → select `dist/`.

## Common commands

| Command | What it does |
|---|---|
| `npm run dev` | watch build |
| `npm run typecheck` | type check |
| `npm test` | unit tests |
| `npm run check` | typecheck + tests + build |
| `npm run eval:extraction` | content-extraction eval against annotated fixture pages |
| `npm run firefox` | build the Firefox package |
| `npm run firefox:source` / `firefox:verify` | reproducible-build source package and verification |

## Layout

```text
doc/        product & design docs (start at doc/README.md); a few internal docs
            (server deployment, pricing/ops, promotion, website) live in the
            private repo instead
src/        extension source: background / content / popup / options / shared
demo/       local demo page
tests/      Vitest unit tests
public/     manifest.json template, icons, locale catalogs
scripts/    build and local-preview scripts
```

## Contributing

Issues and PRs are welcome for the code covered by the AGPL-3.0 license in
this repository. A pull request means you agree to [CLA.md](CLA.md); say so
in the PR description, or ask there first if you're not sure it applies to
you.
