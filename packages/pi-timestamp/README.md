# pi-timestamp

Shows timestamps for user input and agent completion timing.

## What it does

- **User input**: Shows `Sent HH:MM:SS` as a dim status line in the chat display after each user message
- **Agent completion**: Shows `Done at HH:MM:SS · duration` as a dim status line in the chat display after each agent turn (e.g., `Done at 14:32:05 · 3.2s`)

All timestamps are **display-only** — they are shown via Pi's UI notification/status rendering and never enter the LLM context.

## Display behavior

Timestamps appear inline in the **chat display**, similar to Pi's built-in tool timing lines such as `Took 1.9s`. They are not appended to the session as user or custom messages, so they do not pollute the model context.

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
