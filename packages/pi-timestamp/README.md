# pi-timestamp

Shows timestamps for user input and agent completion timing.

## What it does

- **User input**: Shows `Sent HH:MM:SS` after each user message
- **Agent completion**: Shows `Done at HH:MM:SS · duration` after each agent turn (e.g., `Done at 14:32:05 · 3.2s`)

All timestamps are **display-only** — they are sent as custom messages that never enter the LLM context.

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
