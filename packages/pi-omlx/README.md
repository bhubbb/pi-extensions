# pi-omlx

> oMLX provider for [pi](https://pi.dev) — auto-discovers models from a running oMLX server.

**pi-omlx** is a pi extension that bridges your local [oMLX](https://omlx.app) server with the pi coding agent. It scans for all available MLX models, registers them under the `omlx` provider, and handles model loading progress, reasoning-template detection, and multi-modal support — all on Apple Silicon.

## What is oMLX?

oMLX is an Apple Silicon-native ML inference server built on the MLX framework. It serves models locally with zero cloud dependency, leveraging the MPS GPU for fast inference. If you have an Apple Silicon Mac, oMLX gives you a fully local, privacy-first model server.

## Features

- **Auto-discovery** — Scans `~/.omlx/settings.json` and your running oMLX server to find all available models
- **Real-time loading progress** — SSE-powered model load progress with stage labels (weights, draft, projector)
- **Generation stats** — Shows prompt tokens, output tokens, cache reads/writes, cost, and generation time per turn in the widget footer
- **Server stats** — `omlx-stats` command shows build info, context window, and timing data from `/props`
- **Reasoning model support** — Detects `enable_thinking` in chat templates and configures thinking level toggles
- **Multi-modal awareness** — Flags image-capable models and reflects modality support
- **Zero-config setup** — Works out of the box with default oMLX settings, with env var overrides when needed

## Install

**From the shell:**

```bash
pi install git:github.com/bhubbb/pi-omlx
```

This clones to `~/.pi/agent/packages/pi-omlx/` and adds an entry to your pi settings. Every future `pi` invocation auto-loads it.

**From inside an interactive pi session:**

```
!pi install git:github.com/bhubbb/pi-omlx
```

Then run `/reload` (or restart pi) to load the extension.

**Dev mode:**

```bash
git clone https://github.com/bhubbb/pi-omlx ~/code/pi-omlx
pi -e ~/code/pi-omlx/index.ts
```

`-e` loads the extension only for the current session, useful while developing.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `OMLX_BASE_URL` | `http://127.0.0.1:8000/v1` | oMLX server base URL (read from `~/.omlx/settings.json` by default) |
| `OMLX_API_KEY` | `no-key` | API key for oMLX authentication |

## Usage

```bash
# 1. Install oMLX
# (follow instructions at https://omlx.app)

# 2. Start the oMLX server
omlx serve

# 3. Launch pi in another terminal
pi

# 4. Inside pi — search "omlx" to browse your local models
/model
```

## How It Works

1. **On startup**, the extension reads `~/.omlx/settings.json` for server host, port, and API key (overridden by env vars if present)
2. **Model discovery** calls the oMLX `/v1/models` endpoint to enumerate all available models
3. **On model selection**, it queries `/props` for context window and chat template details, and enables auto-loading of the model on the server
4. **SSE stream** on `/models/sse` monitors loading progress in real-time, showing stage-by-stage updates in the pi footer

## Differences from pi-llama

This project was originally forked from [pi-llama](https://github.com/huggingface/pi-llama) but is now fully distinct:

| | pi-llama | pi-omlx |
|---|---|---|
| **Server** | llama.cpp | oMLX (MLX framework) |
| **Provider ID** | `llama-cpp` | `omlx` |
| **Config** | `LLAMA_*` env vars | `OMLX_*` env vars + `~/.omlx/settings.json` |
| **Default port** | `8080` | `8000` |
| **Loading progress** | ❌ | ✅ SSE-based stage tracking |
| **Thinking templates** | ❌ | ✅ Auto-detects `enable_thinking` |
| **Multi-modal** | ❌ | ✅ Image modality awareness |
| **Build info** | ❌ | ✅ `omlx-version` command |
| **Generation stats** | ❌ | ✅ Per-turn token/cost/time in widget footer |
| **Server stats** | ❌ | ✅ `omlx-stats` command with timing breakdown |
| **`time_info` in `/props`** | — | ✅ Prompt time, decode time, total time |
