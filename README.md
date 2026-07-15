# pi-extensions

[![Build Status](https://img.shields.io/badge/Pass%20-%20125%20tests-green.svg)](https://github.com/bhubbb/pi-extensions)

The `pi-extensions` monorepo hosts three extensions for the Pi coding assistant:

- [`pi-advisor`](packages/pi-advisor) — context-policy-aware assistant with configurable thinking, tool use, and summary pre-calls.
- [`pi-llama`](packages/pi-llama) — local LLM inference with multi-backend support, persistent settings, and automatic model discovery.
- [`pi-llama-stats`](packages/pi-llama-stats) — local LLM server metrics (tokens, latency, model switch rate, error rates) with human-friendly formatting and per-model slot rendering.

## Why this exists

The pi project has grown beyond a single extension. These three packages were developed independently and then consolidated into a shared monorepo for easier versioning and shared utilities.

## What's inside

### pi-advisor

A configurable advisor that:

- Maintains a multi-turn context window with configurable mode (`full`, `tail`, `summary`, `summary+tail`).
- Supports configurable thinking depth (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`).
- Enables optional summary pre-calls with a model proxy (defaults to `executor` in memory).
- Tracks and diffs changes between tool results and the final answer.
- Detects verification commands (`npm test`, `bun test`, `cargo test`, etc.) and reports their outcomes.

### pi-llama

A local LLM inference adapter with:

- Support for multiple backend providers (llama-cpp, vllm, text-generation-inference, etc.).
- Automatic model discovery via a local registry (`/var/lib/pi-extensions/models/`).
- Persistent per-model and per-user settings in `~/.pi/agent/pi-llama.json` and `~/.pi/agent/models.json`.
- Automatic model caching and preloading.

### pi-llama-stats

A standalone metrics overlay that:

- Reads per-model latency, token counts, and error rates from the LLM server.
- Renders a human-readable summary at each step with color-coded statistics.
- Provides a fallback when the metrics server is unavailable (shows `?` for missing data).