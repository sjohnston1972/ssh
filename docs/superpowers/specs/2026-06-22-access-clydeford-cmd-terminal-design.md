# Design: `access.clydeford.net` — Browser-based Windows CMD Terminal

**Date:** 2026-06-22
**Status:** Approved for planning
**Host:** This Windows 11 machine (`C:\cloudflare_projects\ssh`)

## Purpose

Provide secure, browser-based access to this Windows host's `cmd.exe` from any
machine on the internet. The user lands on a dashboard of "smart tiles", each a
pre-configured Windows directory; clicking a tile opens a full interactive
terminal already positioned in that directory. Access is gated by Cloudflare
Access using the existing reusable **"mfa"** policy.

## Architectural reality (why not a Cloudflare Worker)

A Cloudflare Worker runs in Cloudflare's edge sandbox and **cannot** spawn
processes or touch this host's filesystem, so it cannot run `cmd.exe`. CMD
execution must live in a process running **on this host**. The browser reaches
it through the existing `cloudflared` tunnel, gated by Cloudflare Access. No
Worker is used.

## Data flow

```
Browser (any machine)
  → access.clydeford.net                 (Cloudflare edge)
  → Cloudflare Access — "mfa" policy      (MFA login enforced)
  → home-docker tunnel                    (cloudflared in Docker Desktop on this host)
  → http://host.docker.internal:7900      (tunnel ingress rule)
  → CMD app (Node.js, native Windows)     (HTTP + WebSocket on :7900)
  → cmd.exe via node-pty                  (one PTY per session)
```

The home-docker tunnel already exposes native-Windows services this way
(`ssh.clydeford.net → ssh://host.docker.internal:22`), so this reuses a proven
pattern. `host.docker.internal` resolves from inside the Docker container back
to this Windows host.

## Discovered environment (ground truth)

- **Zone:** `clydeford.net` (`68c212a7f233ee505d871e816da19600`), active.
- **Tunnel "home-docker":** `ac9da5b2-eaf1-4761-913a-0da854ced2e0`, healthy, 4
  connections — runs inside Docker Desktop on this host.
- **Reusable Access policy "mfa":** `8b4b68fb-ed1b-4e29-90a3-0b11cf2dbc96`
  (decision = allow), shared by 28 apps. **Edited 2026-06-22** to include only
  `stevie.johnston@gmail.com` and `jrsgracey@gmail.com` (Scott Gracey) per user
  request; `csailingclub1901@gmail.com` and `jakatsavras@gmail.com` removed from
  all 28 apps. This is the policy to attach to the new app.
- **No existing Access app** for `access.clydeford.net`.
- **Runtimes on host:** Node v24.15.0, Python 3.14.2. `cloudflared.exe` installed
  at `C:\Program Files (x86)\cloudflared\`.
- **Account ID:** `5bdc4d7840e522355b86631e6b8fac2b`. API token present in `.env`
  and verified valid.

## Decisions (from brainstorming)

| Topic | Decision |
|-------|----------|
| Terminal model | Full interactive PTY (node-pty → cmd.exe, xterm.js, WebSocket) |
| Stack | Node.js (single process: HTTP + WebSocket on port 7900) |
| Path tiles | Config-driven; seeded with `C:\cloudflare_projects\crucible` |
| App-level auth | Verify `Cf-Access-Jwt-Assertion` JWT in addition to Access |
| Tunnel wiring | Reuse home-docker tunnel → `host.docker.internal:7900`; app binds `0.0.0.0` |
| Audit logging | Log sessions **and** commands (with JWT identity) |
| Concurrency | Single active session at a time |
| Persistence | Run as a Windows service (after manual end-to-end validation) |

## Components

All under `C:\cloudflare_projects\ssh`.

- **`server.js`** — HTTP + WebSocket server on port 7900 (bind `0.0.0.0`).
  Serves the static UI, validates the Access JWT on every page load and WS
  upgrade, enforces the single-session rule, manages PTY lifecycle, writes the
  audit log.
- **`pty-session.js`** — wraps `node-pty`, spawning `cmd.exe /K cd /d <path>` so
  the shell opens in the selected tile's directory. One child process per WS
  connection. Killed on disconnect; idle timeout closes stale sessions.
- **`auth.js`** — verifies the `Cf-Access-Jwt-Assertion` header with `jose`:
  issuer `https://clydeford.cloudflareaccess.com`, audience = the new app's AUD
  tag, signature checked against the team's JWKS
  (`https://clydeford.cloudflareaccess.com/cdn-cgi/access/certs`, cached).
  Rejects any request/upgrade that didn't pass Access.
- **`config.json`** — editable tile list: array of `{ label, path, icon }`.
  Seeded with one tile for `C:\cloudflare_projects\crucible`. Adding tiles =
  editing this file and restarting (or it can be re-read per dashboard load).
- **`public/index.html`** — tile dashboard.
- **`public/terminal.html`** — xterm.js terminal view.
- **`public/` assets** — xterm.js + addon(s), styles, client JS.
- **Dependencies:** `ws`, `node-pty`, `jose`. (node-pty compiles a native module
  on Windows; the plan must verify build prerequisites / prebuilt binaries.)

## UI

- **Dashboard (`index.html`):** responsive grid of smart tiles. Each tile shows
  an icon, a label, and the target path. Modern, clean styling (card tiles with
  hover state). Clicking a tile navigates to the terminal view with the chosen
  directory.
- **Terminal (`terminal.html`):** full xterm.js console — arrow keys,
  tab-completion, interactive prompts, live streaming output. Header shows the
  active tile/path; controls to return to the dashboard and to restart the
  session. Because only one session is allowed at a time, opening a new terminal
  replaces the previous one.

## Security

1. **Cloudflare Access** — create an Access **self-hosted application** for
   `access.clydeford.net` and bind the existing reusable **"mfa"** policy.
   The "mfa" policy is now scoped to `stevie.johnston@gmail.com` and
   `jrsgracey@gmail.com` only (done 2026-06-22), because passing MFA grants full
   `cmd.exe` control of the host.
2. **App-level JWT verification** — every page load and WebSocket upgrade must
   carry a valid `Cf-Access-Jwt-Assertion`; the app rejects otherwise. Prevents
   anything that bypassed Access (e.g., direct LAN hit) from using the terminal.
3. **Windows Firewall** — inbound TCP 7900 restricted to the Docker/WSL virtual
   subnet only. The app binds `0.0.0.0` so the container can reach it via
   `host.docker.internal`, but the firewall blocks the physical LAN.
4. **Session hygiene** — single concurrent session; `cmd.exe` killed on
   disconnect; idle timeout; no orphan PTYs.
5. **Audit log** — append-only local log of session start/stop, JWT identity
   (email/sub), and each command entered. Path under
   `C:\cloudflare_projects\ssh\logs\`.

## Cloudflare wiring (via API, token from `.env`)

1. **Tunnel ingress** — GET the home-docker tunnel's current configuration,
   insert `{ hostname: "access.clydeford.net", service: "http://host.docker.internal:7900" }`
   **before** the `http_status:404` catch-all, and PUT the full config back
   (must preserve every existing rule).
2. **DNS** — create a proxied CNAME `access` →
   `ac9da5b2-eaf1-4761-913a-0da854ced2e0.cfargotunnel.com` in zone
   `clydeford.net`.
3. **Access app** — create the self-hosted app for `access.clydeford.net`,
   capture its AUD tag (needed by `auth.js`), and attach the "mfa" policy.

## Running persistently

Validate end-to-end first with a manual `node server.js`. Once confirmed,
install as a Windows service with `node-windows` so it auto-starts on boot.

## Error handling

- **JWT invalid/missing** → 403 on HTTP, refuse WS upgrade.
- **node-pty spawn failure** → send error frame to client, log it, close WS.
- **Tile path missing** → start in a safe default dir and surface a warning.
- **Second concurrent session** → reject (or take over) per single-session rule,
  with a clear message in the UI.
- **Tunnel config PUT** → re-fetch and diff to confirm existing rules preserved;
  abort if the catch-all would be lost.

## Testing

- **Unit:** `auth.js` JWT verification (valid, expired, wrong audience, wrong
  issuer, missing header) against mocked JWKS.
- **Unit:** `config.json` tile parsing (valid, missing path, malformed).
- **Integration:** WebSocket → PTY echo (send a command, assert output);
  disconnect kills the child; single-session enforcement; idle timeout.
- **Manual end-to-end:** browse `access.clydeford.net` from an external machine,
  pass MFA, open the crucible tile, run a command, confirm audit log entry.

## Out of scope (YAGNI)

- Multiple concurrent sessions / multi-user terminals.
- PowerShell or WSL shells (CMD only for v1).
- File upload/download UI.
- A Cloudflare Worker front-end.
