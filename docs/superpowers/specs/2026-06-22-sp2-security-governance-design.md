# SP2 Design: Security / Governance

**Date:** 2026-06-22
**Status:** Approved-by-directive ("deploy the rest"); design decisions stated inline.
**Project:** access.clydeford.net — improvement sub-project 2 of 4.

## Purpose

Add real access control and browser hardening:
1. **Per-identity tile access** — restrict which tiles each user (by JWT email) may see and launch. Today anyone passing the `mfa` policy gets every tile as a full shell.
2. **Security headers (CSP etc.)** on served pages.

## Key design decision (scope honesty)

A command allowlist *inside* a live interactive PowerShell/cmd cannot be robustly enforced (the user types freely into a running process; intercepting/parsing keystrokes is bypassable). So governance is applied at the **launch boundary**: which tiles — and therefore which shell, directory, and auto-run command — each identity may start. A "restricted user" (e.g. Scott) is simply given access to a narrower set of tiles. This is enforceable on both the dashboard (`/api/tiles` filtered) and the WS `start` (server rejects a tile the identity may not launch).

## Decisions

| Topic | Decision |
|-------|----------|
| Tile authorization | Optional `allow: ["email", ...]` on a tile. Absent/empty `allow` = visible to everyone who passes Access. Present = only those emails. |
| Enforcement points | `/api/tiles` returns only allowed tiles; WS `start` rejects a disallowed `tilePath` (sends `error`, no spawn). Defense in depth — never trust the client. |
| Identity | JWT `email` (fallback `sub`), same as SP1. |
| Security headers | CSP + `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options: DENY` / `frame-ancestors 'none'` on all responses. |
| CSP value | `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'` (`unsafe-inline` for style is required because xterm injects a runtime `<style>`; scripts stay strict `'self'`). |

## Components / files

- **`src/config.js`** — pass through optional `allow` (array of strings) on a tile, like `command`/`shell`/`intro`.
- **`src/authz.js`** *(new, tiny)* — `tileAllowed(tile, email) => boolean` (no `allow` ⇒ true; else membership test) and `visibleTiles(tiles, email) => tiles[]`. Pure, unit-tested.
- **`src/server.js`** — `/api/tiles` returns `visibleTiles(tiles, identity)`; identity resolved from the verified JWT (already available as `payload`). On WS `start`, look up the tile and reject (send `{type:'error',message:'Not authorized for this tile'}`, do not call `manager.start`) if `!tileAllowed(tile, identity)`. Add a `securityHeaders(res)` helper applied to every response (HTTP handler + static).
- **`public/dashboard.js`** — unchanged logic (server already filters `/api/tiles`); the `/api/me` email is shown.
- **`config.json`** — no required change; `allow` is opt-in. (Crucible stays open to both.)

## Enforcement detail

- `/api/tiles` (server.js): `JSON.stringify(visibleTiles(tiles, payload.email || payload.sub))`.
- WS `start` (server.js `onConnect`): resolve `tile = tiles.find(t => t.path === msg.tilePath)`. If `tile && !tileAllowed(tile, identity)` → `ws.send(error)`, return (no spawn). If `!tile` (path not a configured tile) → treat as disallowed too (only configured tiles may launch), send `error`. This also tightens the prior behavior where any path could be launched.
- Note: a user could still type `cd` anywhere once in an allowed shell — that's inherent to giving someone a shell. Tile authorization governs *what they can launch*, which (with distinct shells/dirs/commands per tile) is the meaningful control. Documented, not hidden.

## Error handling & edge cases

- Tile with malformed `allow` (non-array) → treated as "no restriction" but logged once at load; or reject at config load. Decision: `loadTiles` validates `allow` is an array of strings if present, else throws (fail fast on bad config).
- `start` for a disallowed/unknown tile → `error` message to client; audit `start_denied{email, path}`.
- Headers must not break xterm: verified by serving the terminal page and confirming the vendored scripts/styles load under the CSP.

## Testing

- **Unit `test/authz.test.js`:** `tileAllowed` (no allow ⇒ true; email in list ⇒ true; not in list ⇒ false; case-insensitive email compare). `visibleTiles` filters correctly for two identities.
- **Unit `test/config.test.js` (extend):** `allow` passthrough; malformed `allow` throws.
- **Integration `test/server.test.js` (extend):** identity A sees only its tiles via `/api/tiles`; WS `start` on a tile A isn't allowed → receives `error`, no session created (`manager.get` absent); allowed tile still works. Security headers present on `/` and `/api/tiles` responses.

## Out of scope

- In-shell command filtering (not robustly enforceable — see decision above).
- Audit viewer (SP4). UI polish (SP3). Rate limiting (future).
