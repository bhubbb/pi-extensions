# pi-llama-stats

Read-only overlay view for llama.cpp server stats (companion to [pi-llama](https://github.com/huggingface/pi-llama)).

## What it does

Opens a TUI overlay showing per-backend server metrics:
- Build info, loaded models, context window, slot state
- Per-slot processing status, tokens decoded, tokens remaining, tok/s
- Model list with status, params, size
- Prometheus metrics (if `--metrics` is enabled on the server)

Auto-refreshes every 2 seconds. Press `r` to force refresh, `q` or `escape` to close.

**Read-only only.** Does not load/unload models, change slots, or mutate server state.

## Install

**From inside pi:**

```
!pi install git:github.com/huggingface/pi-llama-stats
```

Then `/reload` (or restart pi).

**Dev mode:**

```bash
pi -e ~/code/pi-llama-stats/src/index.ts
```

## Usage

- **Hotkey:** `Ctrl+Shift+L` — opens the stats overlay
- **Command:** `/llama-stats` — same, discoverable from `/help`
- **Keyboard inside the view:** `↑`/`↓` scroll, `r` refresh, `q`/`escape` close

Requires at least one llama.cpp backend configured (via `~/.pi/agent/pi-llama.json` or `LLAMA_BASE_URL` env var). If none are configured, you'll see a "No llama.cpp backends configured" notification.

## Notes

- Backends are re-read from disk on each hotkey press, so edits via `/llama-setup` are picked up the next time the view is opened.
- Backends added *while the overlay is open* won't appear until you re-open it.

## Uninstall

```bash
pi remove git:github.com/huggingface/pi-llama-stats
```
