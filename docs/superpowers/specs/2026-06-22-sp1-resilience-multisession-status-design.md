# SP1 Design: Per-user Sessions + Persistence + Connection-status UI

**Date:** 2026-06-22
**Status:** Approved for planning
**Project:** access.clydeford.net browser CMD/PowerShell terminal — improvement sub-project 1 of 4.

## Purpose

Make the terminal solid for real multi-user, remote/mobile use by fixing three things:
1. **Per-user sessions** — today a single global session means a second connection (you on another device, or Scott) silently kicks off the first. Give each identity its own session.
2. **Persistence + replay** — a dropped WebSocket currently kills the shell. Keep the PTY (and Claude) alive across brief disconnects and restore the screen on reconnect.
3. **Connection-status UI** — replace the bare `[disconnected]` text with a clear status pill, reconnect affordance, and an idle-timeout warning.

This is sub-project 1; SP2 (security/governance), SP3 (UI polish), SP4 (file transfer + audit viewer) follow as separate spec→plan→build cycles.

## Current state (baseline)

- `src/server.js` `createServer({tiles, verifier, audit, fallbackDir, idleMinutes})` manages a single module-level `active` session; a new WS connection kills the old PTY and replaces it. PTY killed on ws close. One global idle timer.
- WS protocol: client→server `start{tilePath,cols,rows}` / `input{data}` / `resize{cols,rows}`; server→client `data{data}` / `exit` / `error{message}`.
- `public/terminal.js` connects once, no reconnect; prints `[disconnected]` on close.
- Sessions keyed by nothing (global). Audit logs `session_start`/`session_stop`/`command`.

## Decisions (from brainstorming)

| Topic | Decision |
|-------|----------|
| Session model | Per-user, one session per identity (JWT email). Same user's new tab takes over their live session. |
| Persistence | PTY survives WS drop for a **grace window of 10 minutes**; auto-reconnect reattaches. |
| Replay | Server keeps a **rolling raw-output buffer (cap 256 KB)**; on reattach sends `restore`, client `reset()`s then writes it, then a resize nudge prompts a TUI repaint. |
| Idle timeout | **15 minutes** of no input closes the session; a **60-second** warning precedes it; any input cancels. |
| Status UI | Pill: Connected / Reconnecting / Disconnected + Reconnect button; idle warning banner. |
| Heartbeat | Server-side ws ping/pong to detect half-open sockets and trigger the grace flow. |

## Architecture

```
Browser (terminal.js)
  │  WS /ws  (auto-reconnect w/ backoff)
  ▼
server.js  — authes upgrade (JWT → identity), hands socket to SessionManager
  ▼
SessionManager — Map<identity, Session>
  Session = { term (PTY), email, buffer[], attachedWs, lastActivity,
              graceTimer, idleTimer, idleWarned }
```

A new module **`src/session-manager.js`** owns all session lifecycle so it is unit-testable without HTTP/WS. `server.js` becomes a thin adapter: resolve identity on upgrade, then `manager.attach(identity, ws, audit)`.

### Connection / reattach flow
The client **always sends `start{tilePath,cols,rows}` on every ws open** (first connect and every reconnect — `tilePath` is always available from the URL). The server decides reattach-vs-spawn, which makes grace-expired reconnects self-heal (they just spawn fresh).
1. WS upgrade → `authed(req)` → `payload.email` (identity). Fail → refuse upgrade (unchanged).
2. `manager.attach(identity, ws)` registers the socket for that identity. If a session already has a live `attachedWs`, that previous socket is sent `taken-over` and closed (same-user takeover).
3. On `start{tilePath,cols,rows}`:
   - **Live session exists for identity:** treat as reattach — cancel any `graceTimer`, set `attachedWs = ws`, send `restore{data: buffer}`, send a resize nudge, resume piping `term.onData → ws`. (The spawn request is ignored; the existing PTY continues.)
   - **No session:** spawn PTY (via existing `spawnCmd`, honoring tile `shell`/`command`) → create Session, run the tile's auto-run `command` (existing 500 ms behavior), begin buffering output.
4. On ws `close` (not a clean server-initiated takeover): leave `term` alive, `attachedWs = null`, start `graceTimer(10 min)`. If it fires → kill term, audit `session_stop{reason:'grace_expired'}`, delete session.

### Buffering
- Every `term.onData(d)` appends `d` to `session.buffer` and (if attached) forwards as `data{data:d}`.
- Buffer is a rolling byte budget: append, then while total > 256 KB drop from the front. Stored as an array of chunks with a running byte count.
- On reattach, `restore` sends the concatenated buffer; client `term.reset()` then `term.write(buffer)`.

### Timers
- **idleTimer:** reset on every `input`. At `idleMinutes - 1min` (i.e. 14 min) send `idle-warning{seconds:60}`; at `idleMinutes` (15 min) kill term, audit `session_stop{reason:'idle'}`, delete session. Any `input` before expiry resets the timer and sends `idle-cancel`.
- **graceTimer:** only while detached (see above).
- Heartbeat: server pings each attached ws every 30 s; if a pong isn't seen within the interval, treat as dropped → close ws (→ grace flow).

### Client (terminal.js)
- Connect to `/ws`; on every `open` send `start{tilePath,cols,rows}` (first connect and every reconnect). The server replies with `restore` if a live session exists, else spawns fresh — the client need not track started-state.
- On `close`/error (not intentional): set status **Reconnecting**, auto-reconnect with backoff 0.5→1→2→5→5s (cap), up to the grace window; on success the server sends `restore`. If backoff exhausts/grace expires: status **Disconnected** + **Reconnect** button (button = `location.reload()` → fresh session).
- Handle `restore{data}` → `term.reset(); term.write(data)`. Handle `idle-warning{seconds}` → show banner + countdown; `idle-cancel` → hide. Handle `taken-over` → show "Session opened in another tab", stop reconnecting.
- Status pill reflects ws state: Connected (open) / Reconnecting (backoff) / Disconnected (gave up).

## Components / files

- **Create `src/session-manager.js`** — `createSessionManager({ spawn, audit, idleMs, graceMs, bufferBytes, now })` returning `{ attach(identity, ws, startOpts?), handleMessage(identity, msg), detach(identity, ws), get(identity), shutdown() }`. `spawn`, `now`, and timer scheduling are injectable for tests. Owns Map, buffer, timers, replay.
- **Modify `src/server.js`** — build the manager in `createServer` (and entrypoint); on upgrade resolve identity and delegate ws handling to the manager. Keep `verifier`/`audit`/`fallbackDir`/`idleMinutes`; add `graceMinutes` (default 10) and `bufferBytes` (default 262144). Remove the old single-`active` logic.
- **Modify `public/terminal.js`** — send `start` on every ws open (first + reconnect), reconnect/backoff, status pill, `restore`/`idle-warning`/`taken-over` handling, reconnect button, idle banner.
- **Modify `public/terminal.html`** — status pill element, reconnect button, idle banner; bump asset version (`?v=4`).
- **Modify `public/styles.css`** — pill states (green/amber/red), banner.
- **New WS messages:** server→client `restore{data}`, `idle-warning{seconds}`, `idle-cancel`, `taken-over`. Client→server unchanged (`start`/`input`/`resize`).

## Error handling & edge cases

- **PTY exits while detached:** mark session ended; on reattach send `exit` and prompt fresh start (no zombie).
- **Buffer cap:** oldest chunks evicted; replay may start mid-stream — acceptable; the resize nudge triggers a TUI repaint.
- **JWT expiry mid-session:** reconnect re-runs `authed`; failure refuses the upgrade → client falls to Disconnected → manual reconnect forces re-login. Session continues under grace until it either reattaches or expires.
- **Same-user takeover race:** identity-keyed map; last `attach` wins; previous ws gets `taken-over` then closed.
- **Timer leaks:** killing a session clears both timers and the heartbeat; `shutdown()` clears everything (used by `close()` in tests).
- **Two distinct identities:** fully independent Sessions; never share a PTY or buffer.

## Testing

**Unit — `test/session-manager.test.js`** (inject a fake PTY `{ onData, write, resize, kill, onExit }`, a fake clock/timer, a recording audit):
- new identity + `start` spawns PTY and buffers output;
- second `attach` for same identity with a live detached session replays buffer via `restore` and cancels grace;
- ws close starts grace; grace expiry kills PTY + audits `session_stop{reason:'grace_expired'}`;
- idle expiry kills PTY + audits `session_stop{reason:'idle'}`; `input` resets idle and emits `idle-cancel` after a warning;
- same-identity second attach while first still attached → first gets `taken-over` + closed;
- two identities → two independent sessions;
- buffer eviction keeps total ≤ cap.

**Integration — extend `test/server.test.js`** (real ws, stub verifier returning a chosen email, real cmd/PS PTY):
- two emails get separate sessions (output from A not seen by B);
- drop the ws, reconnect same identity → receives `restore` containing prior output;
- second connection same identity → first ws receives `taken-over`.

All via `node --test test/*.test.js`. Keep the existing 21 tests green (the single-session test is replaced by per-user behavior; update it rather than delete the coverage).

## Out of scope (this sub-project)

- Multiple concurrent sessions/tabs per user (we chose one-per-user). 
- Per-identity authorization, restricted shells (SP2).
- File transfer, audit viewer, log rotation (SP4).
- UI polish: copy/paste, links, search, themes (SP3).
