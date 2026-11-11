# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## 2026-11-11

### Added

- `npm test`. It checks that `src/ui.js` matches `src/ui.html`, syntax-checks the Worker and the local scripts, then runs the Node.js tests in `test/`. The tests cover feed parsing, canonical URLs, Access checks, article queries, read-state redirects, collector fan-out, the internal collector gate, the fixed demo preview, the example Wrangler placeholders, and a text scan for private keys and common token prefixes. No packages are installed.
- `.github/workflows/check.yml`, which runs `npm test` on Node.js 20 for pull requests and for pushes to `main`. It does not install packages or deploy.
- README screenshots taken from the local preview on 2026-11-11: `review/readme-desktop.png`, `review/readme-mobile.png`, and `review/readme-sources.png`.
- This changelog.

### Changed

- Replaced the README with a Chinese and English description of the behavior that is present in this repository, including install, run, and test steps.
- Set `package.json` to version 0.1.1, `"type": "module"`, and the test script above. The build and preview scripts remain CommonJS `.cjs` files.
- Noted in `.gitignore` that tracked review files stay tracked and only `review/*.zip` is ignored. Also ignore editor files and `coverage/`.
- `review/preview.cjs` accepts `PORT` and still defaults to `127.0.0.1:4173`. Removed an unused page read and an unused request log. The demo responses are unchanged, including the fixed collect result.
- Reformatted `scripts/build-ui.cjs`. The generated `src/ui.js` is unchanged.
- Marked `feeds.txt` as an unused draft. `sources.sql` is still the 25-row seed.
- Noted in `HANDOFF.md` that a missing `INTERNAL_KEY` closes `/internal/collect`.
- Removed the unused `UA` constant from `src/worker.js`. The collector still sends the same browser User-Agent.

### Fixed

- `POST /internal/collect` is now rejected when `INTERNAL_KEY` is missing or empty. A configured non-empty secret is still compared with the same check as before. No Wrangler, Access, D1, or secret binding was changed.

## 2026-11-09

### Added

- Initial public Worker, reading page, D1 schema, source seed, and local preview.
