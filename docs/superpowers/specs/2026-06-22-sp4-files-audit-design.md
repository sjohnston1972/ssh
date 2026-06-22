# SP4 Design: File Transfer + Audit Viewer + Log Rotation

**Date:** 2026-06-22
**Status:** Approved-by-directive ("deploy the rest"); decisions inline.
**Project:** access.clydeford.net — improvement sub-project 4 of 4 (final).

## Purpose

1. **File transfer** — upload/download files to/from a tile's folder from the browser.
2. **Audit viewer** — a browser page to read the audit log already recorded.
3. **Log rotation** — prune old audit logs so they don't grow unbounded.

## Security model (critical)

Every new endpoint sits behind the existing JWT gate AND re-applies SP2 per-tile authorization:
- The `path` parameter must be a **configured tile** the identity is **allowed** (`tileAllowed`). Arbitrary filesystem paths are rejected.
- The file name is reduced to its **basename** and the resolved target must stay **inside** the tile folder (`path.relative` containment check) — no traversal.
- Rationale: a user already has a full shell as `steven` in allowed tile folders, so file I/O there is not an escalation; the controls prevent reaching folders/tiles they were NOT granted.
- Upload body size capped (default 100 MB) — oversize ⇒ 413.

## Decisions

| Topic | Decision |
|-------|----------|
| Upload | `PUT /api/upload?path=<tilePath>&name=<file>` with the raw file bytes as the body (no multipart dependency). Writes `tileDir/basename(name)`. |
| Download | `GET /api/download?path=<tilePath>&file=<name>` streams the file (attachment). |
| List | `GET /api/files?path=<tilePath>` → `[{name, size, isDir, mtime}]` for the folder's direct entries. |
| Audit data | `GET /api/audit?limit=N` → newest-first array of parsed audit entries (default 500). |
| Audit access | Any authenticated user (both users are trusted admins under the `mfa` policy). Shows all activity. |
| Audit page | `/audit` → `public/audit.html` table view with a refresh button. |
| Files UI | On the terminal page: a "Files" toggle opens a panel listing the current tile's folder with upload (file picker) + download links + delete-free (read/write only). |
| Rotation | Daily files already (`audit-YYYY-MM-DD.log`). `pruneOldLogs(dir, retentionDays=30)` deletes older files; run at server startup. |

## Components / files

- **`src/audit.js`** — add `pruneOldLogs(dir, retentionDays)` (delete `audit-YYYY-MM-DD.log` with date older than cutoff) and `readRecentAudit(dir, limit)` (read newest log files, parse ndjson, return newest-first up to `limit`). Keep `createAuditLogger` unchanged.
- **`src/files.js`** *(new)* — pure helpers: `resolveTileDir(tiles, path, email)` → returns the tile's folder if the tile is configured AND allowed for `email`, else `null`; `safeChildPath(dir, name)` → `resolve(dir, basename(name))` only if it stays within `dir`, else `null`. Unit-tested.
- **`src/server.js`** — add routes `GET /api/files`, `PUT /api/upload`, `GET /api/download`, `GET /api/audit`, and serve `/audit` → `audit.html`. All use the existing `authed` gate + `resolveTileDir`/`safeChildPath` + `tileAllowed`. Wire `pruneOldLogs(logsDir, RETENTION_DAYS)` once at entrypoint startup. Apply `securityHeaders` (already global).
- **`public/terminal.html` / `terminal.js` / `styles.css`** — a "Files" button + slide-in panel (list, upload picker, download links), scoped to the current `tilePath`. Bump `?v=6`.
- **`public/audit.html` / `audit.js`** *(new)* — table of audit entries from `/api/audit`, refresh button.
- **`config.js`** — unchanged.

## Endpoint behavior detail

- All endpoints resolve `identity = payload.email || payload.sub`. `resolveTileDir(tiles, path, identity)` returns `null` ⇒ respond `403` (not authorized / unknown tile). Keeps file access inside granted tiles only.
- **Upload:** read body to a buffer with a running size guard (abort + 413 over cap); `target = safeChildPath(tileDir, name)`; `null` ⇒ 400; write file; respond `{ok:true, name, size}`. Audit `file_upload{email, path, name, size}`.
- **Download:** `target = safeChildPath(tileDir, file)`; missing/dir ⇒ 404; stream with `content-disposition: attachment; filename="..."`. Audit `file_download{email, path, name}`.
- **List:** read dir entries (non-recursive); return name/size/isDir/mtime. Hidden files included. Errors ⇒ `[]` with 200 (empty folder / unreadable).
- **Audit:** `readRecentAudit(logsDir, limit)`; respond JSON. (CSP already allows same-origin fetch.)

## Error handling & edge cases

- `path` not a configured/allowed tile → 403 on every file endpoint (don't leak whether the folder exists).
- `name`/`file` containing separators or `..` → basename strips them; containment check is the backstop → 400/404.
- Upload over size cap → destroy/abort the request, 413, no partial file left (write to a temp name then rename, or only write after full buffer received — choose: buffer fully then write, simplest, bounded by cap).
- Audit log dir missing or empty → `/api/audit` returns `[]`.
- `pruneOldLogs` ignores non-matching filenames and is a no-op if dir missing.

## Testing

- **Unit `test/files.test.js`:** `resolveTileDir` (configured+allowed ⇒ dir; unknown path ⇒ null; disallowed identity ⇒ null); `safeChildPath` (plain name ⇒ inside; `../escape` ⇒ null; nested `a/b` ⇒ basename inside).
- **Unit `test/audit.test.js` (extend):** `pruneOldLogs` deletes only files older than retention (use temp dir + crafted filenames); `readRecentAudit` returns newest-first across files, respects limit, tolerates malformed lines.
- **Integration `test/server.test.js` (extend):** upload→list→download round-trip into a temp tile folder for an allowed identity; upload to a disallowed tile → 403; download with `../` traversal name → 404/400 (contained); `/api/audit` returns JSON array; oversize upload → 413.
- All via `node --test test/*.test.js`; keep prior tests green.

## Out of scope

- Recursive directory browsing / file deletion / rename from the UI (read+write only for v1).
- Per-user audit filtering (both users are admins).
- Streaming/chunked uploads beyond the size cap.
