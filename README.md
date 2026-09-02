# access-cmd-terminal

A Windows-hosted Node.js service that gives you a full interactive terminal
in your browser, gated behind Cloudflare Access. It presents a dashboard of
configured "tiles" (directories, each optionally with a launch command);
opening a tile spawns a real shell (`node-pty` + `powershell.exe`/`cmd.exe`)
in that directory and streams it to an xterm.js terminal over a WebSocket.
Each tile's terminal also has a Files panel for uploading/downloading files
in that directory, and there's a separate audit log viewer.

## What it does

- **Dashboard** (`/`) — a searchable, groupable grid of tiles read from
  `config.json`. Each tile can restrict itself to specific email addresses
  (`allow`), show a confirmation dialog before opening (`intro`), and run a
  command automatically once the shell starts (`command`).
- **Terminal** (`/terminal`) — xterm.js hooked up over a WebSocket (`/ws`) to
  a `node-pty` session running on the server. Supports reconnect with output
  replay, an idle-timeout warning, search, copy/paste, adjustable font size,
  dark/light theme, fullscreen, and on-screen keys for mobile.
  - Only one session per identity at a time: opening a second tab takes over
    the session and disconnects the first.
  - A disconnected session is kept alive for a grace period so a dropped
    connection can reattach without losing the shell.
  - A Files panel (`GET /api/files`, `PUT /api/upload`, `GET /api/download`)
    lists, uploads to, and downloads from the tile's directory. All three
    accept an optional `subpath` parameter for folder navigation; the panel
    shows a breadcrumb and descends into directories. `subpath` is resolved
    server-side and checked for containment both lexically and against the
    real filesystem path, so traversal (`..`), absolute or cross-drive paths,
    UNC paths, and symlink/junction escapes are all rejected.
- **Audit viewer** (`/audit`) — reads `GET /api/audit`, which serves recent
  entries from the append-only audit log (session start/stop, commands
  typed, file uploads/downloads, denied access attempts), newest first.
  Input typed at a prompt that the terminal does not echo back — a password,
  an enable secret — is never written to the log; the entry is recorded as
  `command_redacted` with no content.
- **Access control** — every HTTP request and WebSocket upgrade must carry a
  valid Cloudflare Access JWT (`Cf-Access-Jwt-Assertion` header or cookie),
  verified against your Access team's JWKS with the expected issuer and
  audience (`src/auth.js`). Per-tile `allow` lists are enforced on top of
  that (`src/authz.js`).

## Prerequisites

- **Windows**, since the app spawns `powershell.exe`/`cmd.exe` via
  `node-pty` and the default tile shell is `powershell.exe`
  (`src/pty-session.js`).
- **Node.js** (a current LTS; CI runs Node 24 — see
  `.github/workflows/ci.yml`).
- **Native build tooling for `node-pty`** — it's a native addon. `npm ci`
  will use a prebuilt binary if one matches your Node/Windows/arch; if not,
  it falls back to compiling, which needs Visual Studio Build Tools (the
  "Desktop development with C++" workload) and Python 3.
- A **Cloudflare Access** setup: a team domain, a self-hosted Access
  application in front of wherever this server is reachable, and that
  application's AUD tag.

## Install

```sh
npm ci
npm run vendor
```

`npm run vendor` (`scripts/copy-vendor.js`) copies the xterm.js runtime and
its addons from `node_modules` into `public/vendor/` (gitignored). The
dashboard and terminal pages load xterm from there, so **the app will not
work in a browser until this has been run at least once** — re-run it after
any xterm/`@xterm/*` dependency bump.

## Configure

Copy `.env.example` to `.env` and fill it in:

```sh
cp .env.example .env
```

`.env` is read by `src/server.js` at startup (`readEnv`) and by
`scripts/wire-cloudflare.js`. `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are
required — the server prints a FATAL error and exits immediately if either
is missing, refusing to start without an enforced JWT audience/issuer. See
`.env.example` for the full list of variables (required and optional, with
their defaults) and comments on what each one does.

Then edit `config.json` to define your tiles. Each entry supports:

| field | required | meaning |
|---|---|---|
| `path` | yes | directory the terminal opens in |
| `label` | no | display name (defaults to `path`) |
| `icon` | no | emoji shown on the tile (defaults to 📁) |
| `command` | no | command auto-run once the shell starts |
| `shell` | no | shell to launch (defaults to `powershell.exe`) |
| `group` | no | heading to group tiles under on the dashboard |
| `allow` | no | array of emails allowed to see/use this tile (omit for everyone) |
| `intro` | no | `{ title, lines }` confirmation dialog shown before opening |

## Run

```sh
npm start
```

Starts the HTTP + WebSocket server (`src/server.js`) on `PORT`/`BIND` from
`.env` (defaults `7900` / `0.0.0.0`).

To run it as a persistent Windows service instead of a foreground process:

```sh
node scripts/install-service.js    # installs and starts the "AccessCmdTerminal" service
node scripts/uninstall-service.js  # removes it
```

(uses `node-windows`; run from an elevated shell).

To wire up the Cloudflare side (tunnel ingress rule, DNS record, Access
application) via the Cloudflare API, once `CLOUDFLARE_ACCOUNT_ID` and
`CLOUDFLARE_API_TOKEN` are set in `.env`:

```sh
npm run wire
```

`scripts/wire-cloudflare.js` targets a specific pre-existing
tunnel/zone/policy configured in that script — read it before running it
against a different Cloudflare account.

## Test

```sh
npm test
```

Runs `node --test test/*.test.js` — unit and integration tests for auth,
authz, config loading, file-path containment, audit logging, the PTY
session wrapper, the session manager, and the HTTP/WS server (including a
real `node-pty`-backed shell). See `.github/workflows/ci.yml` for how this
runs in CI (Windows-only, and why).
