# @fffattiger/pix-cli

Install and run [pix](https://github.com/FFatTiger/pix), a local web workstation for the [pi](https://github.com/earendil-works/pi) coding agent.

Requires Node.js >= 22.19 and an existing pi configuration in `~/.pi`.

## Quick start

```bash
npm install -g @fffattiger/pix-cli
pix start
```

pix serves at `http://127.0.0.1:30141` by default; `pix start` stays attached to the terminal (sessions keep running when it stops).

```bash
pix start --port 30142 --hostname 0.0.0.0 --open
pix start --detach         # run the host in the background
pix status                 # sessiond + background host state
pix logs --follow          # background host output
pix restart                # restart the background host; sessions keep running
pix stop                   # stop the background host; `--all` also stops sessiond
```

Documentation and source: https://github.com/FFatTiger/pix
