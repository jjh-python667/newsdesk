# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## 2026-11-15

### Added

- GitHub OAuth login when `TEAM_DOMAIN` and `ACCESS_AUD` are not both set. Routes are `/auth/github/start`, `/auth/github/callback`, and `/auth/logout`. Only logins listed in `ALLOWED_GITHUB_LOGINS` can sign in. The flow uses PKCE S256, a one-time D1 state row, and an HMAC-signed `__Host-` session cookie. GitHub requests use `redirect: "manual"`.
- `migrations/0001_oauth_states.sql` for an existing D1 database. `schema.sql` creates the same table for a new database.
- Tests for the login page, API 401, allowlist rejection, a successful session cookie, and the manual redirect.

### Changed

- Access JWT checks still run when both `TEAM_DOMAIN` and `ACCESS_AUD` are set. `/internal/collect` and `scheduled` are unchanged.
- README and `HANDOFF.md` describe the GitHub OAuth App, the callback `https://newsdesk.gongjiangcai.workers.dev/auth/github/callback`, and the variables `GITHUB_CLIENT_ID`, `ALLOWED_GITHUB_LOGINS`, `GITHUB_CLIENT_SECRET`, and `SESSION_SECRET`.

## 2026-11-11

### Added

- `npm test`. It checks that `src/ui.js` matches `src/ui.html`, syntax-checks the Worker and the local scripts, then runs the Node.js tests in `test/`. The tests cover feed parsing, canonical URLs, Access checks, article queries, read-state redirects, collector fan-out, the internal collector gate, the fixed demo preview, the example Wrangler placeholders, and a text scan for private keys and common token prefixes. No packages are installed.
- `.github/workflows/check.yml`, which runs `npm test` on Node.js 20 for pull requests and for pushes to `main`.
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

- `POST /internal/collect` is rejected when `INTERNAL_KEY` is missing or empty. A configured non-empty secret is still compared with the same check as before.

## 2026-11-09

### Added

- Initial public Worker, reading page, D1 schema, source seed, and local preview.
