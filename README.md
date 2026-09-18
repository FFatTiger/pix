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

Your browser opens to `http://127.0.0.1:30141` with the pix UI. Useful flags:

```bash
pix start --port 30142 --hostname 0.0.0.0 --no-open
```

To manage the running services:

```bash
pix status   # sessiond / host health
pix down --all
```

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

## License

Project licensing has not yet been decided. Third-party visual assets and their MIT attribution are documented in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
