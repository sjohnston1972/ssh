# SP3 Design: UI Polish Pack

**Date:** 2026-06-22
**Status:** Approved-by-directive ("deploy the rest"); decisions inline.
**Project:** access.clydeford.net — improvement sub-project 3 of 4.

## Purpose

Make the UI pleasant and capable: clickable links, in-terminal search, copy/paste, font-size + theme controls, fullscreen, on-screen keys for mobile, and a searchable/grouped tile dashboard. All client-side except an optional tile `group` field.

## Decisions

| Feature | Decision |
|---------|----------|
| Clickable links | `@xterm/addon-web-links` (vendored) — URLs in output become clickable (open new tab). |
| Search | `@xterm/addon-search` (vendored). `Ctrl+F` toggles a search box (input + next/prev + close); `Esc` closes. |
| Copy | `Ctrl+C` copies the selection if there is one (via `navigator.clipboard`), otherwise passes through as interrupt. `Ctrl+Shift+C` always copies. |
| Paste | `Ctrl+V` / `Ctrl+Shift+V` reads `navigator.clipboard` and sends as input. (https origin = secure context, so clipboard API works.) |
| Font size | `A−` / `A+` buttons in the header adjust `term.options.fontSize` (10–24), then re-fit. Persisted in `localStorage`. |
| Theme | Toggle between **Dark** (default) and **Light** xterm themes; persisted in `localStorage`. |
| Fullscreen | Button toggles `requestFullscreen()` on the terminal host. |
| Mobile keys | A key toolbar (Esc, Tab, Ctrl [sticky], ↑ ↓ ← →, Ctrl+C) shown on touch / narrow screens; sends the right escape sequences over the WS. |
| Dashboard search | A search input filters tiles live by label/path (case-insensitive). |
| Dashboard grouping | Optional tile `group` (string). Tiles render under group headings (ungrouped tiles under no heading / "Other"). |
| Asset cache-bust | Bump versions to `?v=5`. |

## Components / files

- **`scripts/copy-vendor.js`** — also copy `@xterm/addon-web-links` and `@xterm/addon-search` dist into `public/vendor/`. (Install both via npm.)
- **`public/terminal.html`** — load the two new vendor scripts; add header controls (search toggle, A−/A+, theme, fullscreen) and a hidden search box + a mobile key toolbar; bump `?v=5`.
- **`public/terminal.js`** — load web-links + search addons; wire search box; copy/paste key handling via `term.attachCustomKeyEventHandler`; font-size + theme (+ localStorage); fullscreen; mobile-key sends. Keep all SP1 reconnect/status/idle logic intact.
- **`public/index.html`** — add a tile search input; bump `?v=5`.
- **`public/dashboard.js`** — live filter; render grouped sections when tiles have `group`.
- **`public/styles.css`** — styles for header controls, search box, mobile toolbar, group headings.
- **`src/config.js`** — pass through optional `group` (string), like `shell`/`allow`.
- **`config.json`** — no required change (group/links opt-in).

## Verification & testing

- **Unit:** extend `test/config.test.js` — `group` passthrough.
- **Client behavior** has no node test harness; verify via `node --check` on the JS, a serve-check that the vendored addons + `?v=5` assets are reachable and the globals exist, and manual browser checks (links clickable, Ctrl+F search, copy/paste, font/theme/fullscreen, mobile toolbar, dashboard filter/grouping).
- Must not regress SP1 (reconnect/status/idle) or SP2 (CSP — note: clickable links open `target=_blank` to external origins, which navigation is not restricted by our CSP `connect-src`; `navigator.clipboard` needs no CSP allowance; the addons are same-origin `'self'` scripts so `script-src 'self'` still holds).

## Out of scope

- Multiple tabs/sessions (SP1 chose one-per-user). Server-side changes beyond `group` passthrough. File transfer / audit viewer (SP4).
