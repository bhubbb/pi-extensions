# pi-advisor-ext

A [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) extension that adds an `advisor` tool with a configurable context policy — send a summary + tail of the conversation to a stronger reviewer model instead of the full transcript, drastically reducing token waste for local LLM advisors.

## Attribution

This project is a fork of [`hknet/pi-extensions`](https://github.com/hknet/pi-extensions) by [hknet](https://github.com/hknet), specifically the `pi-advisor` package. The upstream `advisor` tool, automatic triggers (`onDone`, `whenStuck`), and `/advise` UX are preserved. Licensed under the EUPL-1.2 (same as upstream).

## What changed from upstream

- **Configurable context policy**: instead of always sending the full transcript, choose between `full`, `tail`, `summary`, or `summary+tail` modes
- **Summary pre-call**: a rolling summary is generated (and cached, refreshed every N messages) so the advisor sees a compressed view of the whole conversation plus recent messages
- **Changed-files/diff digest**: patches are harvested from `tool_result` events and included in the advisor payload
- **`always` trigger**: new auto-mode that runs the advisor before the agent processes each user input
- **Reasoning stripping**: thinking/reasoning blocks are stripped by default to save tokens

## Installation

### Via `pi install` from GitHub

```bash
pi install git:git@github.com:bhubbb/pi-advisor-ext@main
```

Or via HTTPS:

```bash
pi install https://github.com/bhubbb/pi-advisor-ext
```

Or install from a local checkout:

```bash
pi install /path/to/pi-advisor-ext
```

This adds the package source to your pi settings (`~/.pi/agent/settings.json` under `packages`). Pi loads the extension files declared in this package's `package.json` `pi.extensions` manifest. Restart pi if needed, or reload the session with:

```
/reload
```

## Configuration

`advisor.json` (project: `<cwd>/.pi/advisor.json`, or global: `~/.pi/agent/advisor.json`):

```json
{
  "model": "provider/id",
  "summaryModel": "provider/id",
  "thinking": "high",
  "onDone": true,
  "onTodoDone": false,
  "always": true,
  "whenStuck": 3,
  "timeoutMs": 120000,

  "contextMode": "summary+tail",
  "tailMessages": 10,
  "stripReasoning": true,
  "keepToolResults": "recent",
  "diffMode": "stat",
  "diffMaxChars": 4000,
  "summaryMaxTokens": 16384,
  "summaryRefreshEvery": 8,
  "summaryTimeoutMs": 60000
}
```

See [packages/pi-advisor/](./packages/pi-advisor/) for full documentation.

## Privacy note

`pi-advisor` can send conversation context — including reasoning, tool calls, arguments, and tool results — to a reviewer model. It does **not** send anything until you explicitly configure a trusted reviewer model with `/advisor`, `advisor.json`, or `PI_ADVISOR_MODEL`. Use `/advise show` for UI-only feedback; bare `/advise` is optimized for quick intervention and injects advice into the conversation (`pipe` when idle, `steer` while running).

## Developing

1. Edit the `.ts`/`.mjs` source in `packages/pi-advisor/`.
2. Run `npm test` and `npm run typecheck`.
3. Re-deploy with `pi install /path/to/pi-advisor-ext` (or copy manually and run `/reload`).
