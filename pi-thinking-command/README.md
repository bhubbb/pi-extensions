# `/thinking` command extension for pi

Adds a `/thinking` slash command to pi for changing the active thinking/reasoning level from inside a session.

Normally in pi, changing the thinking/reasoning level means opening the settings menu, navigating to **Thinking**, and selecting the requested level. This extension is a convenience shortcut for that workflow, so you can switch levels directly with commands such as `/thinking low` or `/thinking xhigh`.

This is especially useful when switching between model classes. Smaller models, including many local models, often benefit from tighter thinking limits than larger hosted models from major providers.

## Install

Install the full collection via `pi install`:

```bash
pi install git:git@github.com:hknet/pi-extensions@main
```

Or via HTTPS:

```bash
pi install https://github.com/hknet/pi-extensions
```

Or install this extension manually:

```bash
cp pi-thinking-command/thinking-shortcut.ts ~/.pi/agent/extensions/thinking-shortcut.ts
```

After installing, restart pi or run:

```text
/reload
```

## Usage

```text
/thinking [off|minimal|low|medium|high|xhigh]
```

Examples:

```text
/thinking off
/thinking low
/thinking medium
/thinking high
/thinking xhigh
```

If no argument is provided, `/thinking` sets the level to `medium`.

## Levels

- `off` — disable extended thinking
- `minimal` — smallest available thinking budget
- `low` — light reasoning
- `medium` — balanced default reasoning
- `high` — more reasoning for harder tasks
- `xhigh` — maximum reasoning budget

> **Note:** If the current model does not support the requested level, pi clamps to the
> nearest supported level (searching both up and down the level hierarchy).

## Features

- Registers the `/thinking` command.
- Provides argument completions for all supported levels.
- Shows a `thinking` status item with the current level.
- Updates the status item when the thinking level changes.
- Validates input and displays an error for unknown levels.
