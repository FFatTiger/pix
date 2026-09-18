# @fffattiger/pix-cli

Install and run [pix](https://github.com/FFatTiger/pix), a local web workstation for the [pi](https://github.com/earendil-works/pi) coding agent.

Requires Node.js >= 22.19 and an existing pi configuration in `~/.pi`.

## Quick start

```bash
npm install -g @fffattiger/pix-cli
pix start
```

pix opens at `http://127.0.0.1:30141` by default.

```bash
pix status
pix down --all
pix start --port 30142 --hostname 0.0.0.0 --no-open
```

Documentation and source: https://github.com/FFatTiger/pix
