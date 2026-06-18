# pi-timestamp

Shows timestamps for user input and agent completion timing.

## What it does

- **User input**: Shows `Sent HH:MM:SS` in the footer status bar after each user message
- **Agent completion**: Shows `Done at HH:MM:SS · duration` in the footer status bar after each agent turn (e.g., `Done at 14:32:05 · 3.2s`)

All timestamps are **display-only** — they are shown via the footer status bar and never enter the LLM context.

## Display behavior

Timestamps appear in the **footer/status bar**, not inline in the conversation transcript. This avoids polluting the model context while still providing visible timing information. If you want inline transcript timestamps, that would require modifying message content (which the current implementation avoids).

## Installation

```bash
pi install npm:@hk_net/pi-timestamp
```

Or copy manually:

```bash
mkdir -p ~/.pi/agent/extensions
cp packages/pi-timestamp/timestamp.ts ~/.pi/agent/extensions/timestamp.ts
```

## Duration measurement

Captured from `agent_start` (when the model starts processing) to `agent_end` (when all tool calls and model processing are done).
