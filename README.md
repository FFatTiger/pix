# pix

A local web workstation for the [pi](https://github.com/earendil-works/pi) coding agent.

Your sessions live in a resident daemon, not in a browser tab. Close the window, restart the web server, put your laptop to sleep — running agents keep working, and you reconnect from any browser or from the pix PWA on your phone. Sessions are stored as plain JSONL under `~/.pi`, fully shared with the pi CLI: start a conversation in pix, continue it from the terminal, or vice versa.

## Why pix

- **Sessions that don't die with the tab.** The web UI is just a window onto a resident session daemon; refreshes and restarts never kill a running agent.
- **History browsing costs nothing.** Reading past sessions is a pure read-only projection — no worker processes spin up until you interact.
- **Live, structured runtime.** Thinking, tool calls, bash output and file edits stream over WebSocket as typed events, with snapshots resuming exactly where you left off.
- **Real workspace context.** Browse files, git status and worktrees for the session's project without leaving the UI.
- **Installable PWA.** The same client installs to your phone's home screen and talks to your machine over your own network.

## Quick start

Requires Node.js ≥ 22.19 and a working [pi](https://github.com/earendil-works/pi) setup (models and providers come from your existing `~/.pi` configuration).

```bash
npm install -g @fffattiger/pix-cli
pix start
```

`pix start` serves the pix UI at `http://127.0.0.1:30141` (add `--open` to launch your browser). It stays attached to the terminal — Ctrl+C stops the web host while sessions keep running — which is also how service managers (systemd, launchd, Docker) should run it. Useful flags:

```bash
pix start --port 30142 --hostname 0.0.0.0 --open
pix start --detach   # run the web host in the background and return once it is ready
```

To manage the running services:

```bash
pix status            # sessiond + background host state, URL and log path
pix logs --follow     # background host output
pix restart           # restart the background host; sessions keep running
pix stop              # stop the background host; sessions keep running
pix stop --all        # also stop the session daemon (ends running sessions)
pix down --all        # stop the session daemon only
```

`pix restart --all` also restarts the session daemon, and `pix update --restart` relaunches a background host on the new version.

### Windows (preview)

pix runs on Windows 10/11 with the same commands (`npm install -g @fffattiger/pix-cli`, then `pix start` in PowerShell or Windows Terminal). The session daemon uses a per-user named pipe instead of a Unix socket and keeps its state under your user profile. Windows support is a preview: startup is verified on real Windows runners, while parts of the unit-test suite are still being hardened for Windows. See [docs/windows.md](docs/windows.md).

## How it works

```
Browser / PWA
      │
Web process — Vite static client + Hono API/WS gateway        (restartable)
      │  localhost RPC
pix-sessiond — resident daemon, sole session authority
      │
agent-worker × N — one process per session
      │  AgentRuntimePort
pi SDK (via the anti-corruption layer)
```

The web process is disposable by design; `pix-sessiond` owns session lifecycle, and each session runs in its own worker process. All durable state stays in `~/.pi`. The full architecture, invariants and package layout are documented in [docs/refactor-architecture.md](docs/refactor-architecture.md) and [AGENTS.md](AGENTS.md).

## Development

```bash
npm install
npm run check:architecture   # package-boundary and tooling gates
npm run typecheck
npm test
npm run build
```

End-to-end suites (build first): `npm run test:e2e:startup`, `test:e2e:runtime`, `test:e2e:sessions`, `test:e2e:lifecycle-sdk`, `test:e2e:lifecycle-browser`, `test:e2e:multi-tab`.

For a release, update the root version and the Protocol product build version,
then synchronize workspace versions and internal dependencies:

```bash
node scripts/sync-version.mjs write
npm run release:verify -- --publishable --keep
```

This creates a standalone archive and a smaller `-npm.tgz` distribution in an
isolated temporary directory. The standalone checks cover offline installation,
runtime startup, state retention across an upgrade, and uninstall behavior.
The npm archive bundles Pix, Pi's coding-agent SDK, and the patched plugin;
npm installs their external dependencies normally. The SDK 1.0.0 bundle omits
its defective published shrinkwrap. Test the npm archive with a fresh npm
install, then publish it with `npm publish <archive-npm.tgz> --access public`. Neither the script nor
workspace directories publish a release automatically.

## License

Project licensing has not yet been decided. Third-party visual assets and their MIT attribution are documented in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
