# @fffattiger/pix-cli

Install and run [pix](https://github.com/FFatTiger/pix), a local web workstation for the [pi](https://github.com/earendil-works/pi) coding agent.

Requires Node.js >= 22.19 and an existing pi configuration in `~/.pi`.

## Quick start

```bash
npm install -g @fffattiger/pix-cli
pix start
```

pix starts in the background at `http://127.0.0.1:30141` by default.

```bash
pix status                 # sessiond + host state
pix logs --follow          # background host output
pix restart                # restart the host; sessions keep running
pix stop                   # stop the host; `--all` also stops sessiond
pix start --port 30142 --hostname 0.0.0.0 --open
pix start --foreground     # for service managers / containers
```

Documentation and source: https://github.com/FFatTiger/pix
